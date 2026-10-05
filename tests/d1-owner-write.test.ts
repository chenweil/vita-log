import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { createEmptySnapshot, type HealthSnapshot } from '../src/domain';
import { onRequestPut } from '../functions/api/snapshot';
import { onRequest as onSessionRequest } from '../functions/api/session';
import { createOwnerCredential, type OwnerEnv } from '../functions/_lib/owner-credentials';
import { clearRateLimits } from '../functions/_lib/rate-limit';
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, SESSION_TTL_MS } from '../functions/_lib/session';
import type { D1DatabaseLike, D1Statement } from '../functions/_lib/d1-store';

const OWNER = 'owner';
const PASSWORD = 'a sufficiently long owner password';
const ORIGIN = 'https://vita-log.pages.dev';

/** The deployment secret a real deployment would hold. */
const CREDENTIAL = await createOwnerCredential(PASSWORD);
const ownerEnv = (overrides: Partial<OwnerEnv> & { VITA_LOG_DB?: D1DatabaseLike } = {}): OwnerEnv & { VITA_LOG_DB?: D1DatabaseLike } => ({
  VITA_LOG_OWNER_USERNAME: OWNER,
  VITA_LOG_OWNER_CREDENTIAL: CREDENTIAL,
  ...overrides,
});

/**
 * A D1 that models only the tables this ticket writes: the versioned health
 * row and the owner session rows. It counts SQL placeholders the way real D1
 * does, so a mis-paired bind fails here instead of in production.
 */
class FakeD1 implements D1DatabaseLike {
  queries: string[] = [];
  health: { payload: string; version: number; saved_at: string } | null = null;
  sessions = new Map<string, number>();
  constructor(private readonly behaviour?: { error: Error }) {}
  prepare(query: string): D1Statement { this.queries.push(query); return this.statement(query, []); }
  private statement(query: string, values: unknown[]): D1Statement {
    return {
      bind: (...next: unknown[]): D1Statement => {
        const placeholders = (query.match(/\?/g) ?? []).length;
        if (values.length + next.length !== placeholders) throw new Error(`expected ${placeholders} bindings, got ${values.length + next.length}`);
        return this.statement(query, [...values, ...next]);
      },
      first: async <T = Record<string, unknown>>(): Promise<T | null> => {
        if (this.behaviour) throw this.behaviour.error;
        if (/FROM health_state/.test(query)) {
          return this.health ? ({ payload: this.health.payload, version: this.health.version, saved_at: this.health.saved_at } as T) : null;
        }
        if (/FROM owner_session/.test(query)) {
          const expiresAt = this.sessions.get(String(values[0]));
          return expiresAt === undefined ? null : ({ expires_at: expiresAt } as T);
        }
        throw new Error(`unexpected query: ${query}`);
      },
      run: async (): Promise<{ meta: { changes: number } }> => {
        if (this.behaviour) throw this.behaviour.error;
        if (/UPDATE health_state/.test(query)) {
          // Real optimistic concurrency: the write lands only on the expected
          // version, and `meta.changes` is how the Worker learns it did not.
          if (!this.health || this.health.version !== Number(values[3])) return { meta: { changes: 0 } };
          this.health = { payload: String(values[0]), version: this.health.version + 1, saved_at: String(values[1]) };
          return { meta: { changes: 1 } };
        }
        if (/INSERT INTO owner_session/.test(query)) {
          this.sessions.set(String(values[0]), Number(values[1]));
          return { meta: { changes: 1 } };
        }
        if (/DELETE FROM owner_session/.test(query)) {
          return { meta: { changes: this.sessions.delete(String(values[0])) ? 1 : 0 } };
        }
        throw new Error(`unexpected query: ${query}`);
      },
    };
  }
}

const snapshotRow = (snapshot: HealthSnapshot, version: number): FakeD1 => {
  const db = new FakeD1();
  db.health = { payload: JSON.stringify(snapshot), version, saved_at: snapshot.updatedAt };
  return db;
};

/**
 * Issue a save. A browser always sends `Origin` on a write, so the helper
 * defaults it, and every header goes through `Headers` so a forged one really
 * reaches the request instead of being dropped as an unknown RequestInit key.
 */
const callPut = (db: D1DatabaseLike | undefined, body: unknown, extraHeaders: Record<string, string> = {}, env: Partial<OwnerEnv> & { VITA_LOG_DB?: D1DatabaseLike } = {}) => {
  const headers = new Headers({ 'content-type': 'application/json', origin: ORIGIN, ...extraHeaders });
  return onRequestPut({
    request: new Request(`${ORIGIN}/api/snapshot`, { method: 'PUT', headers, body: JSON.stringify(body) }),
    env: ownerEnv({ VITA_LOG_DB: db, ...env }),
  });
};

/** The same save, but with the request headers spelled out in full. */
const callPutWithHeaders = (db: D1DatabaseLike | undefined, body: unknown, extraHeaders: Record<string, string>, env: Partial<OwnerEnv> & { VITA_LOG_DB?: D1DatabaseLike } = {}) => {
  const headers = new Headers({ 'content-type': 'application/json', ...extraHeaders });
  return onRequestPut({
    request: new Request(`${ORIGIN}/api/snapshot`, { method: 'PUT', headers, body: JSON.stringify(body) }),
    env: ownerEnv({ VITA_LOG_DB: db, ...env }),
  });
};

const sessionRequest = (db: D1DatabaseLike | undefined, init: RequestInit & { body?: string }, env: Partial<OwnerEnv> & { VITA_LOG_DB?: D1DatabaseLike } = {}) => {
  const headers = new Headers(init.headers);
  if (init.method && init.method !== 'GET' && !headers.has('origin')) headers.set('origin', ORIGIN);
  return onSessionRequest({ request: new Request(`${ORIGIN}/api/session`, { ...init, headers }), env: ownerEnv({ VITA_LOG_DB: db, ...env }) });
};

const login = async (db: D1DatabaseLike | undefined, env: Partial<OwnerEnv> = {}): Promise<string> => {
  const response = await sessionRequest(db, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: OWNER, password: PASSWORD }) }, env);
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie') ?? '';
};

const attemptLogin = (db: D1DatabaseLike | undefined, password: string, ip?: string, env: Partial<OwnerEnv> & { VITA_LOG_DB?: D1DatabaseLike } = {}) => {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (ip) headers.set('cf-connecting-ip', ip);
  return sessionRequest(db, { method: 'POST', headers, body: JSON.stringify({ username: OWNER, password }) }, env);
};

/**
 * Rate-limit buckets live in a Worker global, so the suite clears them between
 * cases. Without this a later test would start with a spent budget and "the
 * limit engages" would pass for the wrong reason.
 */
beforeEach(() => { clearRateLimits(); });
afterEach(() => { vi.useRealTimers(); });

describe('D1 owner 写入授权契约', () => {
  it('未登录写入被拒绝', async () => {
    const db = snapshotRow(createEmptySnapshot(), 3);
    const response = await callPut(db, { snapshot: createEmptySnapshot(), expectedVersion: 3 });
    expect(response.status).toBe(401);
    expect((await response.json() as { code: string }).code).toBe('unauthorized');
    expect(db.health?.version).toBe(3);
  });

  it('正确密码登录后写入成功并推进版本', async () => {
    const db = snapshotRow(createEmptySnapshot(), 3);
    const cookie = await login(db);
    const next = createEmptySnapshot('2026-10-06T09:00:00.000Z');
    next.settings.name = '轻盈';
    const response = await callPut(db, { snapshot: next, expectedVersion: 3 }, { cookie });
    expect(response.status).toBe(200);
    const body = await response.json() as { version: number; savedAt: string };
    expect(body.version).toBe(4);
    expect(db.health?.version).toBe(4);
    expect(JSON.parse(db.health?.payload ?? '{}').settings.name).toBe('轻盈');
  });

  it('错误密码或错误账号登录失败，不发放会话', async () => {
    const db = snapshotRow(createEmptySnapshot(), 1);
    for (const body of [
      { username: OWNER, password: '' },
      { username: OWNER, password: 'wrong-password' },
      { username: OWNER, password: `${PASSWORD} ` },
      { username: OWNER, password: PASSWORD.toUpperCase() },
      { username: 'someone-else', password: PASSWORD },
    ]) {
      const response = await sessionRequest(db, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.status, JSON.stringify(body)).toBe(401);
      expect((await response.json() as { code: string }).code).toBe('unauthorized');
      expect(response.headers.get('set-cookie')).toBeNull();
    }
    expect(db.sessions.size).toBe(0);
  });

  it('会话 Cookie 使用 HttpOnly、Secure、SameSite=Strict 且限时', async () => {
    const db = snapshotRow(createEmptySnapshot(), 1);
    const setCookie = (await sessionRequest(db, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: OWNER, password: PASSWORD }),
    })).headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/api');
    expect(setCookie).toContain(`Max-Age=${SESSION_MAX_AGE_SECONDS}`);
    // 30 minutes, and the session value is not the password.
    expect(SESSION_MAX_AGE_SECONDS).toBe(1800);
    expect(SESSION_TTL_MS).toBe(30 * 60 * 1000);
    expect(setCookie).not.toContain(PASSWORD);
  });

  it('D1 中只存会话令牌摘要，不存可直接使用的令牌', async () => {
    const db = snapshotRow(createEmptySnapshot(), 1);
    const cookie = await login(db);
    const token = cookie.split(';')[0]!.split('=')[1]!;
    expect(db.sessions.size).toBe(1);
    expect([...db.sessions.keys()]).not.toContain(token);
  });

  it('会话 30 分钟后绝对过期，写入恢复为只读', async () => {
    const db = snapshotRow(createEmptySnapshot(), 1);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T08:00:00.000Z'));
    const cookie = await login(db);
    expect((await callPut(db, { snapshot: createEmptySnapshot(), expectedVersion: 1 }, { cookie })).status).toBe(200);

    // Absolute, not sliding: activity before the deadline does not extend it.
    vi.setSystemTime(new Date('2026-10-06T08:29:00.000Z'));
    expect((await callPut(db, { snapshot: createEmptySnapshot(), expectedVersion: 2 }, { cookie })).status).toBe(200);

    vi.setSystemTime(new Date('2026-10-06T08:30:01.000Z'));
    const late = await callPut(db, { snapshot: createEmptySnapshot(), expectedVersion: 3 }, { cookie });
    expect(late.status).toBe(401);
    expect((await late.json() as { code: string }).code).toBe('unauthorized');
    expect(db.health?.version).toBe(3);
  });

  it('注销立即撤销服务端会话', async () => {
    const db = snapshotRow(createEmptySnapshot(), 1);
    const cookie = await login(db);
    expect((await callPut(db, { snapshot: createEmptySnapshot(), expectedVersion: 1 }, { cookie })).status).toBe(200);

    const logout = await sessionRequest(db, { method: 'DELETE', headers: { cookie } });
    expect(logout.status).toBe(200);
    // Revoked server-side, so the cookie is useless even before it expires.
    const afterLogout = await callPut(db, { snapshot: createEmptySnapshot(), expectedVersion: 2 }, { cookie });
    expect(afterLogout.status).toBe(401);
    expect((await afterLogout.json() as { code: string }).code).toBe('unauthorized');
    expect(db.health?.version).toBe(2);
  });

  it('过期版本返回稳定 version-conflict，且不覆盖已保存数据', async () => {
    const db = snapshotRow(createEmptySnapshot(), 7);
    const cookie = await login(db);
    for (const expectedVersion of [0, 6, 8, -1, 1.5, Number.NaN]) {
      const response = await callPut(db, { snapshot: createEmptySnapshot(), expectedVersion }, { cookie });
      expect(response.status, String(expectedVersion)).toBe(409);
      expect((await response.json() as { code: string }).code, String(expectedVersion)).toBe('version-conflict');
    }
    expect(db.health?.version).toBe(7);
  });

  it('跨站写请求被拒绝，不发放 CORS 头', async () => {
    const db = snapshotRow(createEmptySnapshot(), 1);
    const cookie = await login(db);
    for (const origin of ['https://attacker.example', 'http://vita-log.pages.dev', 'https://vita-log.pages.dev.attacker.example']) {
      const response = await callPut(db, { snapshot: createEmptySnapshot(), expectedVersion: 1 }, { cookie, origin });
      expect(response.status, origin).toBe(403);
      expect((await response.json() as { code: string }).code, origin).toBe('unauthorized');
    }
    const sameOrigin = await callPut(db, { snapshot: createEmptySnapshot(), expectedVersion: 1 }, { cookie, origin: ORIGIN });
    expect(sameOrigin.status).toBe(200);
    // No CORS surface at all: the API is same-origin only and never negotiates
    // one, so a cookie cannot be used from another origin.
    expect(sameOrigin.headers.get('access-control-allow-origin')).toBeNull();
    expect(sameOrigin.headers.get('access-control-allow-credentials')).toBeNull();
    expect(db.health?.version).toBe(2);
  });

  it('缺失 Origin 与 Sec-Fetch-Site: cross-site 同样拒绝', async () => {
    const db = snapshotRow(createEmptySnapshot(), 1);
    const cookie = await login(db);
    // A browser always sends Origin on a write, so its absence is itself the
    // signal that this is not a same-origin request.
    const noOrigin = await callPutWithHeaders(db, { snapshot: createEmptySnapshot(), expectedVersion: 1 }, { cookie });
    expect(noOrigin.status).toBe(403);

    const crossSite = await callPut(db, { snapshot: createEmptySnapshot(), expectedVersion: 1 }, { cookie, origin: ORIGIN, 'sec-fetch-site': 'cross-site' });
    expect(crossSite.status).toBe(403);
    expect(db.health?.version).toBe(1);
  });

  it('Host 不匹配时拒绝写入', async () => {
    const db = snapshotRow(createEmptySnapshot(), 1);
    const cookie = await login(db);
    const response = await callPut(db, { snapshot: createEmptySnapshot(), expectedVersion: 1 }, { cookie, host: 'attacker.example' });
    expect(response.status).toBe(403);
    expect(db.health?.version).toBe(1);
  });

  it('登录按 IP 限流，触发后即使密码正确也拒绝', async () => {
    const db = snapshotRow(createEmptySnapshot(), 1);
    let limited = false;
    for (let attempt = 0; attempt < 40 && !limited; attempt += 1) {
      const response = await attemptLogin(db, 'wrong-password', '203.0.113.7');
      expect([401, 429], `attempt ${attempt}`).toContain(response.status);
      expect((await response.json() as { code: string }).code).toBe('unauthorized');
      if (response.status === 429) {
        limited = true;
        // Once limited, the right password must not be a way around it.
        const correct = await attemptLogin(db, PASSWORD, '203.0.113.7');
        expect(correct.status).toBe(429);
        expect((await correct.json() as { code: string }).code).toBe('unauthorized');
      }
    }
    expect(limited, 'per-IP rate limit never engaged').toBe(true);
  });

  it('轮换来源 IP 不能绕过同一账号的限流预算', async () => {
    const db = snapshotRow(createEmptySnapshot(), 1);
    let limited = 0;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await attemptLogin(db, 'wrong-password', `198.51.100.${attempt}`);
      expect([401, 429]).toContain(response.status);
      if (response.status === 429) limited += 1;
    }
    // A fresh address must not hand an attacker a fresh budget for one
    // account; the account limiter is what closes that.
    expect(limited).toBeGreaterThan(0);
  });

  it('登录成功后清空失败计数，不会被自己的限流锁死', async () => {
    const db = snapshotRow(createEmptySnapshot(), 1);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect((await attemptLogin(db, 'wrong-password', '203.0.113.20')).status).toBe(401);
    }
    expect((await attemptLogin(db, PASSWORD, '203.0.113.20')).status).toBe(200);
    // The success restored the budget, so a slip of the fingers cannot lock the
    // owner out of their own site.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect((await attemptLogin(db, 'wrong-password', '203.0.113.20')).status).toBe(401);
    }
  });

  it('缺少部署凭据时登录与写入都 fail-closed', async () => {
    const db = snapshotRow(createEmptySnapshot(), 1);
    for (const env of [
      { VITA_LOG_OWNER_CREDENTIAL: undefined, VITA_LOG_OWNER_USERNAME: undefined },
      { VITA_LOG_OWNER_CREDENTIAL: undefined },
      { VITA_LOG_OWNER_USERNAME: undefined },
      { VITA_LOG_OWNER_CREDENTIAL: 'not-a-credential' },
      { VITA_LOG_OWNER_CREDENTIAL: 'pbkdf2-sha256$1$00$00' },
    ]) {
      const response = await attemptLogin(db, PASSWORD, '203.0.113.30', env);
      expect(response.status, JSON.stringify(env)).toBe(401);
      expect(response.headers.get('set-cookie')).toBeNull();
    }
    expect(db.sessions.size).toBe(0);
  });

  it('D1 不可用时 fail-closed，不返回成功', async () => {
    const db = snapshotRow(createEmptySnapshot(), 1);
    const cookie = await login(db);

    const noDatabase = await callPut(undefined, { snapshot: createEmptySnapshot(), expectedVersion: 0 }, { cookie });
    expect(noDatabase.status).toBe(503);
    expect((await noDatabase.json() as { code: string }).code).toBe('database-unavailable');

    const broken = await callPut(new FakeD1({ error: new Error('D1 down') }), { snapshot: createEmptySnapshot(), expectedVersion: 0 }, { cookie });
    expect(broken.status).toBe(503);
    expect((await broken.json() as { code: string }).code).toBe('database-unavailable');

    // An empty D1 has no row to update, and the first import is a migration
    // (06.1-03) — so a save must not quietly create the online source of truth.
    const empty = new FakeD1();
    const emptyCookie = await login(empty);
    const emptySave = await callPut(empty, { snapshot: createEmptySnapshot(), expectedVersion: 0 }, { cookie: emptyCookie });
    expect(emptySave.status).toBe(503);
    // A different problem from a stale version, and the owner is told which.
    const emptyBody = await emptySave.json() as { code: string; message: string };
    expect(emptyBody.code).toBe('database-unavailable');
    expect(emptyBody.message).toContain('尚未导入');
    expect(empty.health).toBeNull();
  });

  it('非法快照载荷被拒绝且不落库', async () => {
    const db = snapshotRow(createEmptySnapshot(), 1);
    const cookie = await login(db);
    for (const snapshot of [null, 'nope', { app: 'other' }, { app: 'vita-log', schemaVersion: 99 }, { app: 'vita-log', schemaVersion: 1 }]) {
      const response = await callPut(db, { snapshot, expectedVersion: 1 }, { cookie });
      expect(response.status, JSON.stringify(snapshot)).toBe(400);
      expect((await response.json() as { code: string }).code).toBe('validation-failed');
    }
    expect(db.health?.version).toBe(1);
  });

  it('健康数据响应一律 no-store', async () => {
    const db = snapshotRow(createEmptySnapshot(), 1);
    const cookie = await login(db);
    expect((await callPut(db, { snapshot: createEmptySnapshot(), expectedVersion: 1 }, { cookie })).headers.get('cache-control')).toBe('no-store');
    expect((await callPut(db, { snapshot: createEmptySnapshot(), expectedVersion: 1 })).headers.get('cache-control')).toBe('no-store');
  });

  it('会话状态查询不泄露任何凭据材料', async () => {
    const response = await sessionRequest(snapshotRow(createEmptySnapshot(), 1), {});
    expect(response.status).toBe(200);
    const body = await response.text();
    const parsed = JSON.parse(body) as Record<string, unknown>;
    // `version` is a monotonic counter the owner needs for the next save; it
    // carries no health data, and it is 0 for anyone who is not logged in.
    expect(Object.keys(parsed).sort()).toEqual(['loggedIn', 'until', 'version']);
    expect(parsed.loggedIn).toBe(false);
    expect(parsed.version).toBe(0);
    for (const forbidden of ['credential', 'salt', 'hash', 'digest', 'password', PASSWORD, CREDENTIAL]) {
      expect(body, `泄露 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('会话查询反映已登录状态', async () => {
    const db = snapshotRow(createEmptySnapshot(), 1);
    const cookie = await login(db);
    const parsed = await (await sessionRequest(db, { headers: { cookie } })).json() as { loggedIn: boolean; until: number };
    expect(parsed.loggedIn).toBe(true);
    expect(parsed.until).toBeGreaterThan(0);
  });
});

describe('部署凭据来源', () => {
  it('createOwnerCredential 产出可校验的 PBKDF2 凭据', async () => {
    const credential = await createOwnerCredential(PASSWORD);
    expect(credential).not.toContain(PASSWORD);
    expect(credential.startsWith('pbkdf2-sha256$210000$')).toBe(true);
  });
});
