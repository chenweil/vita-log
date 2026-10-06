import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stripComments } from './support/strip-comments';

/**
 * Which repository each build is wired to.
 *
 * The marker is the contract between the build and the page: the self-hosted
 * Node server injects `content="sqlite"` while serving, and the Cloudflare
 * build injects `content="d1"` at build time. Both are read by one branch in
 * `main.ts`. If the two halves ever disagree on the spelling, the Cloudflare
 * deployment silently falls back to the pure static build — and the symptom is
 * not an error, it is a healthy-looking empty dashboard for every visitor,
 * which is exactly the silent downgrade ADR-0002 rules out.
 *
 * These cases read files rather than importing anything, so they live in the
 * node environment: `new URL(<literal>, import.meta.url)` is rewritten by Vite
 * into a dev-server asset URL, which is why the path is built with
 * `path.resolve` (see the same note in `tests/support/sqlite-d1.ts`).
 */
const projectFile = (path: string): string => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', path), 'utf8');

const MARKER = /<meta name="vita-log-storage" content="([^"]+)">/;

/** The marker a build with this environment would publish, if any. */
const markerFor = async (env: Record<string, string | undefined>): Promise<string | null> => {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const config = (await import('../vite.config')).default as { plugins?: Array<{ name?: string; transformIndexHtml?: (html: string) => string }> };
  const plugin = (config.plugins ?? []).find((candidate) => candidate?.name === 'vita-log-storage-mode');
  return plugin?.transformIndexHtml ? MARKER.exec(plugin.transformIndexHtml('<html><head></head></html>'))?.[1] ?? null : null;
};

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('部署模式标记与 main.ts 的接线一致', () => {
  it('Cloudflare 构建注入 d1 标记，且 main.ts 按同一个值挂载 D1 仓库', async () => {
    expect(await markerFor({ VITE_STORAGE_MODE: 'd1' })).toBe('d1');
    const main = projectFile('src/main.ts');
    expect(stripComments(main)).toMatch(/storageMode === 'd1'/);
    // The marker only earns its keep if the branch behind it is the real adapter.
    expect(main).toContain('new D1HealthRepository()');
    expect(main).toContain('new ServerEditorAuth()');
  });

  it('未设置构建模式时不注入任何标记，纯静态构建保持只读', async () => {
    expect(await markerFor({ VITE_STORAGE_MODE: undefined }), '纯静态构建不得声称自己连接了在线服务').toBeNull();
  });

  it('未知模式同样不注入标记：拼错的配置必须退回只读，而不是半连接', async () => {
    // A near-miss spelling is the dangerous case: accepting it would hand a
    // Cloudflare deployment a marker main.ts does not recognise.
    expect(await markerFor({ VITE_STORAGE_MODE: 'd1 ', VITA_LOG_STORAGE_MODE: 'postgres' })).toBeNull();
  });

  it('自托管服务的 sqlite 标记仍被同一个分支识别', () => {
    // The Node server injects this while serving rather than at build time, so
    // it is checked against main.ts directly instead of through the plugin.
    expect(projectFile('server/main.ts')).toContain('<meta name="vita-log-storage" content="sqlite">');
    expect(stripComments(projectFile('src/main.ts'))).toMatch(/storageMode === 'sqlite'/);
  });

  it('Cloudflare 构建脚本确实设置了该变量', () => {
    // The plugin is unit-tested above, but nothing there proves the script
    // anyone actually runs sets the variable. A `build:cloudflare` that quietly
    // omitted it would publish a read-only build that looks healthy.
    const scripts = JSON.parse(projectFile('package.json')).scripts as Record<string, string>;
    expect(scripts['build:cloudflare']).toContain('VITE_STORAGE_MODE=d1');
  });

  it('GitHub Pages 的静态构建不设置该变量', () => {
    // The same page is deployed as a pure static build there. Injecting the
    // marker would point it at an API that does not exist.
    const scripts = JSON.parse(projectFile('package.json')).scripts as Record<string, string>;
    expect(scripts['build:pages']).not.toContain('VITE_STORAGE_MODE');
  });
});
