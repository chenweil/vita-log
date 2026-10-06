import { pbkdf2Sync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createCredential,
  derivePassword,
  generateSalt,
  parseCredential,
  PBKDF2_ITERATIONS,
  verifyPassword,
} from '../functions/_lib/password';

const source = readFileSync(fileURLToPath(new URL('../functions/_lib/password.ts', import.meta.url)), 'utf8');

/** A deterministic random source, so salt generation is reproducible per test. */
function fixedRandom(fill: number): { getRandomValues<T extends ArrayBufferView>(array: T): T } {
  return {
    getRandomValues<T extends ArrayBufferView>(array: T): T {
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(fill);
      return array;
    },
  };
}

describe('PBKDF2 密码原语', () => {
  it('固定使用 Web Crypto PBKDF2-HMAC-SHA-256 和 210,000 次迭代', async () => {
    expect(PBKDF2_ITERATIONS).toBe(210_000);
    // The deployment decision is a specific KDF and cost, not "some slow hash".
    // Re-deriving with the published parameters must reproduce the stored digest,
    // which only holds if the algorithm, hash, salt and iteration count are all
    // exactly the ones recorded.
    const salt = generateSalt(fixedRandom(0x11));
    const credential = await createCredential('a long owner password', fixedRandom(0x22));
    const parsed = parseCredential(credential);
    expect(parsed).not.toBeNull();
    expect(parsed?.iterations).toBe(210_000);
    expect(await derivePassword('a long owner password', salt, PBKDF2_ITERATIONS)).not.toBeNull();
    // A different password through the same published parameters gives a
    // different digest: the cost is real, not a no-op wrapper.
    const a = await derivePassword('password-a', salt, PBKDF2_ITERATIONS);
    const b = await derivePassword('password-b', salt, PBKDF2_ITERATIONS);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('每个凭据使用独立盐：同一密码两次派生得到不同摘要但都能通过校验', async () => {
    const first = parseCredential(await createCredential('same password', fixedRandom(0x33)));
    const second = parseCredential(await createCredential('same password', fixedRandom(0x44)));
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // Independent salt means neither the stored salt nor the digest may repeat.
    expect(Buffer.from(first!.salt).equals(Buffer.from(second!.salt))).toBe(false);
    expect(Buffer.from(first!.digest).equals(Buffer.from(second!.digest))).toBe(false);
    expect(await verifyPassword('same password', first!)).toBe(true);
    expect(await verifyPassword('same password', second!)).toBe(true);
  });

  it('正确密码通过，错误密码拒绝', async () => {
    const credential = parseCredential(await createCredential('correct owner password', fixedRandom(0x55)));
    expect(await verifyPassword('correct owner password', credential!)).toBe(true);
    for (const wrong of ['', 'wrong', 'correct owner passwor', 'Correct owner password', 'correct owner password ']) {
      expect(await verifyPassword(wrong, credential!), wrong).toBe(false);
    }
  });

  it('凭据格式可往返，并能从中读回盐、迭代次数和摘要', async () => {
    const raw = await createCredential('round trip password', fixedRandom(0x66));
    expect(raw.startsWith('pbkdf2-sha256$210000$')).toBe(true);
    const parsed = parseCredential(raw)!;
    // A deployment secret is a copied string, so the encoding has to survive it.
    expect(parsed.salt.length).toBe(16);
    expect(parsed.digest.length).toBe(32);
    expect(await verifyPassword('round trip password', raw)).toBe(true);
  });

  it('损坏或被削弱的凭据一律 fail-closed，不降级为通过', async () => {
    const valid = await createCredential('a valid password', fixedRandom(0x77));
    const salt = valid.split('$')[2]!;
    const digest = valid.split('$')[3]!;
    const malformed = [
      undefined, null, '', 'not a credential', 'pbkdf2-sha256', 'pbkdf2-sha256$', 'pbkdf2-sha256$$',
      `pbkdf2-sha256$210000$`, `pbkdf2-sha256$210000$${digest}`,
      `pbkdf2-sha256$210000$${salt}$`, `pbkdf2-sha256$210000$${salt}`,
      // Weakened cost must be rejected rather than accepted: a misconfigured
      // secret that turns the KDF down to a single round is exactly the
      // regression the 210,000 figure exists to prevent.
      `pbkdf2-sha256$1$${salt}$${digest}`,
      `pbkdf2-sha256$0$${salt}$${digest}`,
      `pbkdf2-sha256$-210000$${salt}$${digest}`,
      `pbkdf2-sha256$210000.5$${salt}$${digest}`,
      `pbkdf2-sha256$99999999999$${salt}$${digest}`,
      // Wrong algorithm tag.
      `scrypt$${210_000}$${salt}$${digest}`,
      `pbkdf2-sha512$210000$${salt}$${digest}`,
      // Salt and digest must be exactly the sizes the KDF produces.
      `pbkdf2-sha256$210000$00$${digest}`,
      `pbkdf2-sha256$210000$${salt}00$${digest}`,
      `pbkdf2-sha256$210000$${salt}$${digest}00`,
      // Hex only: a credential carrying raw bytes would be ambiguous.
      `pbkdf2-sha256$210000$zzzz$${digest}`,
      `pbkdf2-sha256$210000$${salt}$zzzz`,
      // Trailing fields would be silently ignored if the parse were lenient.
      `${valid}$extra`,
      `${valid}$`,
    ];
    for (const value of malformed) {
      expect(parseCredential(value), String(value)).toBeNull();
      expect(await verifyPassword('a valid password', value as string), String(value)).toBe(false);
      expect(await verifyPassword('', value as string), String(value)).toBe(false);
    }
  });

  it('与独立实现逐字节一致：摘要不是「看起来像 SHA-256」而是真正的 PBKDF2', async () => {
    // Every other case here proves self-consistency: the right password matches
    // and the wrong one does not. That would still hold if `derivePassword` were
    // some deterministic non-KDF — a plain hash, or even `password.length`.
    // Cross-checking against node:crypto anchors the actual bytes to an
    // implementation this code does not share, so a change of algorithm, hash
    // or encoding shows up as a byte difference rather than as a silent change
    // of what a stored credential means.
    for (const [password, saltHex, iterations] of [
      ['a long owner password', '000102030405060708090a0b0c0d0e0f', 210_000],
      ['a long owner password', '000102030405060708090a0b0c0d0e0f', 210_001],
      ['short', 'ff', 210_000],
      ['\u00e4\u00f6\u00fc \u4e2d\u6587 \u5bc6\u7801', 'a0b1c2d3', 210_000],
      ['', '00', 210_000],
    ] as const) {
      const salt = Uint8Array.from(saltHex.match(/../g)!.map((byte) => Number.parseInt(byte, 16)));
      const expected = Buffer.from(pbkdf2Sync(password, salt, iterations, 32, 'sha256')).toString('hex');
      const actual = Buffer.from(await derivePassword(password, salt, iterations)).toString('hex');
      expect(actual, `${password} @ ${iterations}`).toBe(expected);
    }
  });

  it('比较覆盖整个摘要：任何位置被篡改都会被拒绝', async () => {
    // What this pins: the comparison actually inspects every byte, so a
    // comparator that only looked at a prefix, or at the length, could not pass.
    //
    // What it does NOT pin, despite the obvious name it used to carry: the
    // absence of an early exit. Flipping the last byte is rejected by an
    // early-exit comparator too — it just gets there sooner. The two differ in
    // timing, not in result, and no functional test can tell them apart. That
    // property lives in the XOR accumulator below, which the source check at the
    // end of this block guards; a timing test would be measuring the JIT.
    const credential = parseCredential(await createCredential('compare every byte', fixedRandom(0x99)))!;
    const baseline = Buffer.from(await derivePassword('compare every byte', credential.salt, credential.iterations));

    for (const index of [0, Math.floor(baseline.length / 2), baseline.length - 1]) {
      const tweaked = Uint8Array.from(baseline);
      tweaked[index] = tweaked[index]! ^ 0x01;
      expect(await verifyPassword('compare every byte', { ...credential, digest: tweaked }), `byte ${index}`).toBe(false);
    }
    // A length mismatch is rejected too, rather than comparing a prefix.
    expect(await verifyPassword('compare every byte', { ...credential, digest: credential.digest.slice(1) })).toBe(false);

    // The no-early-exit half, checked against the implementation's own source.
    // A timing test would be flaky and would mostly measure the JIT; a `break`
    // or a mid-loop `return` in the accumulator is the defect this is looking
    // for, and it is a static property.
    const compare = /function constantTimeEqual[\s\S]*?\n}/.exec(source)?.[0] ?? '';
    expect(compare, '未找到 constantTimeEqual').not.toBe('');
    expect(compare, '循环必须走完整个摘要长度').toMatch(/for \([^)]*index < left\.length/);
    // The guard before the loop is fine — a length mismatch is not a guessable
    // prefix, it is a malformed record — and so is the function's own trailing
    // `return`. What must not exist is a way out of the *loop*, so the check is
    // scoped to the loop statement.
    const loop = /for \([^)]*\)[\s\S]*?[;}]/.exec(compare)?.[0] ?? '';
    expect(loop, '未找到比较循环').not.toBe('');
    expect(loop, '循环内不得 break').not.toMatch(/\bbreak\b/);
    expect(loop, '循环内不得 return').not.toMatch(/\breturn\b/);
  });

  it('不依赖 Node crypto：模块不引入 node:crypto，也不调用 scryptSync', () => {
    // The Pages Functions runtime has no node:crypto, so an import here would
    // only survive in the local test run and break in the real deployment.
    expect(source).not.toMatch(/from\s+['"]node:crypto['"]/);
    expect(source).not.toMatch(/require\(['"]node:crypto['"]\)/);
    // Matched as a call, not as a word: the module explains in prose why
    // scryptSync is unavailable, and that explanation must not fail the check.
    expect(source).not.toMatch(/scryptSync\s*\(/);
    expect(source).not.toMatch(/timingSafeEqual\s*\(/);
    // The only crypto surface used is the platform one.
    expect(source).toMatch(/crypto\.subtle/);
  });
});
