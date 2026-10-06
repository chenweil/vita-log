import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { transform } from 'esbuild';
import { CREDENTIAL_SHAPES, findCredentialMaterial, MINIFIED_CREDENTIAL_SHAPES } from '../scripts/credential-scan.mjs';

const projectRoot = new URL('../', import.meta.url).pathname;

describe('凭据材料扫描器', () => {
  it('识别真实凭据形状', () => {
    const positives = [
      [`const passwordHash = '9f86d081884c7d65';`, 'passwordHash 字面量'],
      [`{ passwordHash: "5f4dcc3b5aa765d61d8327deb882cf99" }`, 'passwordHash 字面量'],
      [`const salt = '0123456789abcdef0123456789abcdef';`, 'salt 字面量'],
      // A placeholder is not a credential: it carries no secret, and flagging
      // one would point the check at files that are already safe.
      [`passwordHash: "REDACTED_RETIRED_CREDENTIAL", salt: "REDACTED_RETIRED_CREDENTIAL"`, null],
      ['pbkdf2-sha256$210000$0123456789abcdef0123456789abcdef$0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789', '预置的 PBKDF2 凭据'],
      [`const stored = 'scrypt$0123456789abcdef0123456789abcdef';`, '预置的 scrypt 凭据'],
      [`const username = 'chenweil@example.com';`, '真实账号或口令字面量'],
    ] as const;
    for (const [text, expected] of positives) {
      expect(findCredentialMaterial(text), text.slice(0, 40)).toBe(expected);
    }
  });

  it('不在正常代码与说明文字上误报', () => {
    // A check that fires on prose, on a type declaration, or on the field name
    // in a projection list gets disabled rather than fixed — so these have to
    // stay silent for the check to be worth anything.
    const negatives = [
      `passwordHash: ''`,
      `passwordHash: string;`,
      `salt: string;`,
      `const saltBytes = 16;`,
      // The legitimate PBKDF2 parameter constant, which mentions the KDF.
      `export const PBKDF2_ITERATIONS = 210_000;`,
      // Field names in a projection list and a type, not values.
      `for (const key of PUBLIC_SETTING_KEYS) picked[key]`,
      `// passwordHash: 'REDACTED_RETIRED_CREDENTIAL'`,
      `username: 'owner'`,
      `password: 'change-me'`,
      // A redaction placeholder, in a comment or in code, is never a secret.
      `passwordHash: 'REDACTED_RETIRED_CREDENTIAL'`,
      `const passwordHash = "REDACTED";`,
    ];
    for (const text of negatives) {
      expect(findCredentialMaterial(text), text.slice(0, 40)).toBeNull();
    }
  });

  it('构建产物用值形状扫描：标识符被改名也能抓到', () => {
    // The bundler renames locals, so `passwordHash` reaches dist/ as `const
    // e="9f86…"`. A name-keyed check sails past the one place it matters most.
    // This is the exact shape that came out of the build during development.
    const minified = 'const e="9f86d081884c7d659a87fc5b8e2b9c3f4d5e6a7b";return e.length>0;';
    expect(findCredentialMaterial(minified)).toBeNull();
    expect(findCredentialMaterial(minified, { minified: true })).toBe('疑似盐或摘要的长十六进制字面量');
    // A 16-byte salt is half that length and still has to be caught.
    expect(findCredentialMaterial('const a="0123456789abcdef0123456789abcdef";', { minified: true }))
      .toBe('疑似盐或摘要的长十六进制字面量');
  });

  it('真实压缩器改名后仍被抓到', async () => {
    // This used to read dist/assets. It passed here only because a stale local
    // build was sitting on the machine: dist/ is gitignored and CI runs
    // `npm test` *before* `npm run build`, so on a fresh checkout the directory
    // does not exist. The risk it covered is narrower than the bundle anyway —
    // that the real minifier renames the binding and the name-keyed shapes go
    // blind — and that reproduces without a build, using the minifier vite
    // itself uses. Scanning the real artifact is verify-release.mjs's job, and
    // CI runs that after the build.
    const source = `const passwordHash = '9f86d081884c7d659a87fc5b8e2b9c3f4d5e6a7b';`;
    const bundled = (await transform(`${source} export { passwordHash };`, { minify: true })).code;
    // The premise, stated behaviourally: the name-keyed shape sees the source
    // and is blind to the minified output. If a future minifier stopped
    // renaming, the middle assertion turns red instead of the test passing for
    // the wrong reason.
    expect(findCredentialMaterial(source), '前提不成立：源码里的凭据本就没被抓到').toBe('passwordHash 字面量');
    expect(findCredentialMaterial(bundled), '压缩产物仍被名字抓到，本用例的前提已不成立').toBeNull();
    expect(findCredentialMaterial(bundled, { minified: true })).toBe('疑似盐或摘要的长十六进制字面量');
  });

  it('每条值形状都有能触发它的样本（模式不会静默失效）', () => {
    const samples = [
      'const e="9f86d081884c7d659a87fc5b8e2b9c3f4d5e6a7b";',
      `x='pbkdf2-sha256$210000$0123456789abcdef0123456789abcdef$0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'`,
      `x='scrypt$0123456789abcdef0123456789abcdef'`,
    ];
    for (const shape of MINIFIED_CREDENTIAL_SHAPES) {
      expect(samples.some((sample) => shape.pattern.test(sample)), `没有能触发「${shape.label}」的样本`).toBe(true);
    }
  });

  it('当前源码与构建脚本不含凭据材料', () => {
    // tests/ is deliberately absent: it carries synthetic KDF fixtures that the
    // value shapes cannot tell from a real salt — `d1-password.test.ts` pins
    // `00010203…` as the salt of a *non*-210,000-iteration case. A file's own
    // test fixture is not a shipped secret, and the artifact that does ship is
    // covered by verify-release.mjs. Widening this to tests/ would need an
    // allowlist entry, which is a weaker guard than the boundary it buys.
    const files = [
      ...readdirSync(join(projectRoot, 'src')).map((name) => join(projectRoot, 'src', name)),
      ...readdirSync(join(projectRoot, 'server')).map((name) => join(projectRoot, 'server', name)),
      ...readdirSync(join(projectRoot, 'functions/_lib')).map((name) => join(projectRoot, 'functions/_lib', name)),
      ...readdirSync(join(projectRoot, 'functions/api')).map((name) => join(projectRoot, 'functions/api', name)),
    ];
    for (const path of files) {
      const found = findCredentialMaterial(readFileSync(path, 'utf8'));
      expect(found, `${path} 含 ${found}`).toBeNull();
    }
  });

  it('扫描器自己不会被自己的模式命中', () => {
    // The patterns live in a repository file, so a scanner that matched its own
    // source would either never be committed or be special-cased away.
    expect(findCredentialMaterial(readFileSync(join(projectRoot, 'scripts/credential-scan.mjs'), 'utf8'))).toBeNull();
  });

  it('每条模式都至少有一条能触发它的样本（模式不会静默失效）', () => {
    const samples: Record<string, string> = {
      'passwordHash 字面量': `passwordHash = 'abc'`,
      'salt 字面量': `salt = '0123456789abcdef'`,
      '预置的 PBKDF2 凭据': `pbkdf2-sha256$210000$0123456789abcdef0123456789abcdef$0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789`,
      '预置的 scrypt 凭据': `scrypt$0123456789abcdef0123456789abcdef`,
      '真实账号或口令字面量': `username = 'someone@example.com'`,
    };
    for (const shape of CREDENTIAL_SHAPES) {
      expect(samples[shape.label], `没有 ${shape.label} 的样本`).toBeDefined();
      expect(shape.pattern.test(samples[shape.label]!), shape.label).toBe(true);
    }
  });
});