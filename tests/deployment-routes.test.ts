import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteD1 } from './support/sqlite-d1';
import { stripComments } from './support/strip-comments';

const functionsDirectory = new URL('../functions/', import.meta.url).pathname;
const apiDirectory = join(functionsDirectory, 'api');
const projectRoot = new URL('../', import.meta.url).pathname;

/** `/api/login` -> `api/login.ts`, the way Pages Functions maps files to routes. */
const deployedRoutes = (): Set<string> => new Set(
  readdirSync(apiDirectory)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `/api/${name.replace(/\.ts$/, '')}`),
);

/** Every same-origin URL a browser adapter asks for, and the method it uses. */
const clientCalls = (source: string): Array<{ url: string; method: string }> => {
  const found: Array<{ url: string; method: string }> = [];
  for (const match of source.matchAll(/fetch\(\s*'(\/api\/[^']+)'[^)]*?method:\s*'(\w+)'/g)) {
    found.push({ url: match[1]!, method: match[2]! });
  }
  for (const match of source.matchAll(/fetch\(\s*'(\/api\/[^']+)'\s*,\s*\{([^}]*)\}/g)) {
    const method = /method:\s*'(\w+)'/.exec(match[2] ?? '')?.[1] ?? 'GET';
    if (!found.some((call) => call.url === match[1] && call.method === method)) found.push({ url: match[1]!, method });
  }
  return found;
};

/**
 * Every `/api/...` literal in the source, however it is referenced.
 *
 * `clientCalls` only sees a URL when it is passed straight to `fetch`. A route
 * chosen by a variable — `fetch(endpoint)` — is invisible to it, which is how a
 * client kept a `/api/setup` fallback that no deployment served while every one
 * of these tests stayed green. Scanning the literals closes that: a named route
 * the deployment does not serve is a runtime 404 regardless of how it is
 * referenced. Template literals count, so a backtick cannot become the way past
 * this check; comments are stripped first so that the prose explaining why
 * `/api/setup` is gone is not mistaken for a call to it.
 */
const apiLiterals = (source: string): string[] => [...new Set(
  [...stripComments(source).matchAll(/['"`](\/api\/[A-Za-z0-9_/-]+)['"`]/g)].map((match) => match[1]!),
)];

describe('部署路由与浏览器适配器一致', () => {
  it('Pages Functions 暴露的 API 路由就是文件列表', () => {
    expect([...deployedRoutes()].sort()).toEqual(['/api/login', '/api/logout', '/api/migrate', '/api/migration-preview', '/api/owner-snapshot', '/api/session', '/api/snapshot']);
  });

  it('D1 适配器请求的每个 URL 都真实存在', () => {
    const source = readFileSync(join(projectRoot, 'src/d1-storage.ts'), 'utf8');
    const routes = deployedRoutes();
    const calls = clientCalls(source);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      // GET-only routes (the session probe) may be served by the same file that
      // also handles mutations; every URL still has to resolve to a real file.
      expect(routes, `${call.method} ${call.url} 没有对应的 Pages Function`).toContain(call.url);
    }
    for (const literal of apiLiterals(source)) {
      expect(routes, `D1 适配器引用了 ${literal}，但部署里没有这个 Function`).toContain(literal);
    }
  });

  it('共享的 ServerEditorAuth 请求的每个 URL 都真实存在', () => {
    // This client drives both backends. Its paths are the contract: if the
    // Cloudflare deployment did not serve /api/login and /api/logout, login
    // would 404 at runtime while the client tests stayed green.
    const source = readFileSync(join(projectRoot, 'src/server-auth.ts'), 'utf8');
    const routes = deployedRoutes();
    const calls = clientCalls(source);
    for (const call of calls) {
      expect(routes, `${call.method} ${call.url} 没有对应的 Pages Function`).toContain(call.url);
    }
    expect(calls.map((call) => call.url).sort()).toEqual(['/api/login', '/api/logout', '/api/session']);
    // Beyond the exact list above: this is the half of the check that survives a
    // URL being routed through a variable. Without it, a reintroduced
    // `/api/setup` fallback would pass by being invisible rather than by being
    // right.
    expect(apiLiterals(source).sort(), '客户端引用了精确列表之外的 API 路径').toEqual(calls.map((call) => call.url).sort());
  });

  it('functions/schema.sql 真正建出了代码依赖的表', () => {
    // The double executes this DDL, so a drifted copy would let the whole suite
    // run against a schema the deployment never has. Comments are stripped
    // *before* splitting on `;`, because the header prose contains semicolons
    // that would otherwise cut a comment in half and hand the tail to SQLite.
    // The double already reads this file by default; passing it explicitly
    // here just makes the test's dependency on it visible.
    const fresh = new SqliteD1();
    const tables = (fresh.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name).sort();
    expect(tables).toEqual(['health_state', 'owner_session']);

    // The columns the write and session paths bind must exist, or the deployed
    // DDL and the running code disagree about the shape of the row.
    const healthColumns = (fresh.db.prepare('PRAGMA table_info(health_state)').all() as Array<{ name: string }>).map((row) => row.name).sort();
    expect(healthColumns).toEqual(['id', 'payload', 'saved_at', 'version']);
    const sessionColumns = (fresh.db.prepare('PRAGMA table_info(owner_session)').all() as Array<{ name: string }>).map((row) => row.name).sort();
    expect(sessionColumns).toEqual(['expires_at', 'token_hash']);
    fresh.close();
  });
});
