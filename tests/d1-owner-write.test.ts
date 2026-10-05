import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { createEmptySnapshot, type HealthSnapshot } from '../src/domain';
import { onRequestPut } from '../functions/api/snapshot';
import { onRequest as onSessionRequest } from '../functions/api/session';
import { createOwnerCredential, type OwnerEnv } from '../functions/_lib/owner-credentials';
import { clearRateLimits } from '../functions/_lib/rate-limit';
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, SESSION_TTL_MS } from '../functions/_lib/session';
import { WRITE_ATTEMPTS as WRITE_LIMIT } from '../functions/_lib/rate-limit';
import type { D1DatabaseLike } from '../functions/_lib/d1-store';
import { SqliteD1 } from './support/sqlite-d1';

const OWNER = 'owner';
const PASSWORD = 'a sufficiently long owner password';
const ORIGIN = 'https://vita-log.pages.dev';
const HOST = 'vita-log.pages.dev';

/** The deployment secret a real deployment would hold. */
const CREDENTIAL = await createOwnerCredential(PASSWORD);
const ownerEnv = (overrides: Partial<OwnerEnv> & { VITA_LOG_DB?: D1DatabaseLike } = {}): OwnerEnv & { VITA_LOG_DB?: D1DatabaseLike } => ({
  VITA_LOG_OWNER_USERNAME: OWNER,
  VITA_LOG_OWNER_CREDENTIAL: CREDENTIAL,
  ...overrides,
});

const snapshotRow = (snapshot: HealthSnapshot, version: number): SqliteD1 => {
  const db = new SqliteD1();
  db.seed(JSON.stringify(snapshot), version);
  return db;
};

/**
 * Issue a save. A browser always sends `Origin` on a write, so the helper
 * defaults it, and every header goes through `Headers` so a forged one really
 * reaches the request instead of being dropped as an unknown RequestInit key.
 */
const callPut = (db: D1DatabaseLike | undefined, body: unknown, extraHeaders: Record<string, string> = {}, env: Partial<OwnerEnv> & { VITA_LOG_DB?: D1DatabaseLike } = {}) => {
  // Host is set explicitly: a browser and the Cloudflare edge both send it, and
  // requireSameOrigin refuses a write that arrives without one.
  const headers = new Headers({ 'content-type': 'application/json', origin: ORIGIN, host: HOST, ...extraHeaders });
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
  if (init.method && init.method !== 'GET') {
    if (!headers.has('origin')) headers.set('origin', ORIGIN);
    if (!headers.has('host')) headers.set('host', HOST);
  }
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
    expect(db.storedVersion()).toBe(3);
  });

  it('保存真正推进 D1 里的版本：两个页签各持同一版本时只有一个能存', async () => {
    // The regression this pins: a statement that checks `version = ?` in its
    // WHERE clause but never advances the column in its SET clause leaves the
    // stored version invariant. Every write then still matches, so both saves
    // succeed and one tab's edit is silently lost. A fake that applied the
    // UPDATE in JavaScript hid this completely; the statement has to run.
    const db = snapshotRow(createEmptySnapshot(), 4);
    const tabA = await login(db);
    const tabB = await login(db);

    const first = createEmptySnapshot('2026-10-06T09:00:00.000Z');
    first.settings.name = 'tabA';
    const savedA = await callPut(db, { snapshot: first, expectedVersion: 4 }, { cookie: tabA });
    expect(savedA.status).toBe(200);
    expect((await savedA.json() as { version: number }).version).toBe(5);

    // The version really moved in the database, not just in the reply.
    expect(db.storedVersion()).toBe(5);

    // Tab B still holds version 4, so its write must be refused rather than
    // overwriting tab A.
    const second = createEmptySnapshot('2026-10-06T10:00:00.000Z');
    second.settings.name = 'tabB';
    const savedB = await callPut(db, { snapshot: second, expectedVersion: 4 }, { cookie: tabB });
    expect(savedB.status).toBe(409);
    expect((await savedB.json() as { code: string }).code).toBe('version-conflict');
    expect(db.storedName()).toBe('tabA');
    expect(db.storedVersion()).toBe(5);
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
    expect(db.storedVersion()).toBe(4);
    expect(db.storedName()).toBe('轻盈');
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
    expect(db.sessionRows()).toBe(0);
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
    expect(db.sessionRows()).toBe(1);
    expect(db.sessionKeys()).not.toContain(token);
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
    expect(db.storedVersion()).toBe(3);
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
    expect(db.storedVersion()).toBe(2);
  });

  it('过期版本返回稳定 version-conflict，且不覆盖已保存数据', async () => {
    const db = snapshotRow(createEmptySnapshot(), 7);
    const cookie = await login(db);
    for (const expectedVersion of [0, 6, 8, -1, 1.5, Number.NaN]) {
      const response = await callPut(db, { snapshot: createEmptySnapshot(), expectedVersion }, { cookie });
      expect(response.status, String(expectedVersion)).toBe(409);
      expect((await response.json() as { code: string }).code, String(expectedVersion)).toBe('version-conflict');
    }
    expect(db.storedVersion()).toBe(7);
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
    expect(db.storedVersion()).toBe(2);
  });

  it('缺失 Origin 与 Sec-Fetch-Site: cross-site 同样拒绝', async () => {
    const db = snapshotRow(createEmptySnapshot(), 1);
    const cookie = await login(db);
    // A browser always sends Origin on a write, so its absence is itself the
    // signal that this is not a same-origin request.
    const noOrigin = await callPutWithHeaders(db, { snapshot: createEmptySnapshot(), expectedVersion: 1 }, { cookie, host: HOST });
    expect(noOrigin.status).toBe(403);

    const crossSite = await callPut(db, { snapshot: createEmptySnapshot(), expectedVersion: 1 }, { cookie, origin: ORIGIN, 'sec-fetch-site': 'cross-site' });
    expect(crossSite.status).toBe(403);
    expect(db.storedVersion()).toBe(1);
  });

  it('Host 不匹配或缺失时拒绝写入', async () => {
    const db = snapshotRow(createEmptySnapshot(), 1);
    const cookie = await login(db);

    const forged = await callPut(db, { snapshot: createEmptySnapshot(), expectedVersion: 1 }, { cookie, host: 'attacker.example' });
    expect(forged.status).toBe(403);
    expect((await forged.json() as { code: string }).code).toBe('unauthorized');

    // A missing Host is refused rather than skipped, so the check can never
    // quietly not run on a request that carries no Host at all.
    const headers = new Headers({ 'content-type': 'application/json', origin: ORIGIN, cookie });
    const absent = await onRequestPut({
      request: new Request(`${ORIGIN}/api/snapshot`, { method: 'PUT', headers, body: JSON.stringify({ snapshot: createEmptySnapshot(), expectedVersion: 1 }) }),
      env: ownerEnv({ VITA_LOG_DB: db }),
    });
    expect(absent.status).toBe(403);
    expect(db.storedVersion()).toBe(1);
  });

  it('注销时数据库故障不谎报已注销', async () => {
    // Claiming "logged out" while the row survived would tell the owner their
    // editor rights are gone while they stay usable for the rest of the TTL.
    const broken = new SqliteD1({ error: new Error('D1 down') });
    const response = await sessionRequest(broken, { method: 'DELETE', headers: { cookie: 'vita-log-session=whatever' } });
    expect(response.status).toBe(503);
    expect((await response.json() as { code: string }).code).toBe('database-unavailable');
  });

  it('写接口按来源地址限流', async () => {
    // The session key alone would let N logins buy N times the budget. The
    // ticket names account/IP for the write path too, and the address bucket is
    // what binds before the platform WAF layer is configured.
    const db = snapshotRow(createEmptySnapshot(), 1);
    const cookie = await login(db);
    // Read the current version each time, so a 429 is the only thing that can
    // end the loop — otherwise a 409 from a stale version would pass for one.
    const save = (): Promise<Response> =>
      callPut(db, { snapshot: createEmptySnapshot(), expectedVersion: db.storedVersion() }, { cookie, 'cf-connecting-ip': '203.0.113.90' });

    let limited = false;
    for (let attempt = 0; attempt < WRITE_LIMIT + 20 && !limited; attempt += 1) {
      const response = await save();
      expect([200, 429], `attempt ${attempt}`).toContain(response.status);
      if (response.status === 429) {
        limited = true;
        // Once limited, even a perfectly current version is refused.
        expect((await save()).status).toBe(429);
      }
    }
    expect(limited, 'write address limit never engaged').toBe(true);
  });

  it('同一地址的多次登录不能把写预算翻倍', async () => {
    // Two sessions from one address. The per-session budget is generous, so if
    // only that dimension existed neither session would ever hit its own limit
    // and the pair could write without bound. The address budget is what binds
    // the pair, and the loop stops well before either session's own limit.
    const db = snapshotRow(createEmptySnapshot(), 1);
    const first = await login(db);
    const second = await login(db);
    const cookies = [first, second];
    // Each session spends roughly half its own budget, so neither one could
    // reach its per-session limit on its own. Anything that stops them must be
    // the budget they share.
    const half = Math.floor(WRITE_LIMIT / 2) + 10;
    for (let index = 0; index < half; index += 1) {
      const response = await callPut(db, { snapshot: createEmptySnapshot(), expectedVersion: db.storedVersion() }, { cookie: first, 'cf-connecting-ip': '203.0.113.91' });
      expect(response.status, `first session write ${index}`).toBe(200);
    }

    let secondWrites = 0;
    let limited = false;
    while (secondWrites < WRITE_LIMIT) {
      secondWrites += 1;
      const response = await callPut(db, { snapshot: createEmptySnapshot(), expectedVersion: db.storedVersion() }, { cookie: second, 'cf-connecting-ip': '203.0.113.91' });
      expect([200, 429]).toContain(response.status);
      if (response.status === 429) { limited = true; break; }
    }
    expect(limited, 'write address limit never engaged').toBe(true);
    // Neither session came near its own limit: only the shared address budget
    // can be what stopped the second one.
    expect(half).toBeLessThan(WRITE_LIMIT);
    expect(secondWrites).toBeLessThan(WRITE_LIMIT);
    expect(cookies).toHaveLength(2);
  });

  it('注销顺带清理已过期会话行', async () => {
    const db = snapshotRow(createEmptySnapshot(), 1);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T08:00:00.000Z'));
    const stale = await login(db);
    expect(db.sessionRows()).toBe(1);

    vi.setSystemTime(new Date('2026-10-06T09:00:00.000Z'));
    const fresh = await login(db);
    expect(db.sessionRows()).toBe(2);

    // Nothing else ever deletes a lapsed row, so owner_session would otherwise
    // grow one dead row per login forever. Revoking also sweeps them, which is
    // why the table is empty afterwards: the lapsed row was pruned and the live
    // one was revoked.
    await sessionRequest(db, { method: 'DELETE', headers: { cookie: fresh } });
    expect(db.sessionRows()).toBe(0);
    expect((await callPut(db, { snapshot: createEmptySnapshot(), expectedVersion: 1 }, { cookie: fresh })).status).toBe(401);
    expect((await callPut(db, { snapshot: createEmptySnapshot(), expectedVersion: 1 }, { cookie: stale })).status).toBe(401);
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
    expect(db.sessionRows()).toBe(0);
  });

  it('D1 不可用时 fail-closed，不返回成功', async () => {
    const db = snapshotRow(createEmptySnapshot(), 1);
    const cookie = await login(db);

    const noDatabase = await callPut(undefined, { snapshot: createEmptySnapshot(), expectedVersion: 0 }, { cookie });
    expect(noDatabase.status).toBe(503);
    expect((await noDatabase.json() as { code: string }).code).toBe('database-unavailable');

    const broken = await callPut(new SqliteD1({ error: new Error('D1 down') }), { snapshot: createEmptySnapshot(), expectedVersion: 0 }, { cookie });
    expect(broken.status).toBe(503);
    expect((await broken.json() as { code: string }).code).toBe('database-unavailable');

    // An empty D1 has no row to update, and the first import is a migration
    // (06.1-03) — so a save must not quietly create the online source of truth.
    const empty = new SqliteD1();
    const emptyCookie = await login(empty);
    const emptySave = await callPut(empty, { snapshot: createEmptySnapshot(), expectedVersion: 0 }, { cookie: emptyCookie });
    expect(emptySave.status).toBe(503);
    // A different problem from a stale version, and the owner is told which.
    const emptyBody = await emptySave.json() as { code: string; message: string };
    expect(emptyBody.code).toBe('database-unavailable');
    expect(emptyBody.message).toContain('尚未导入');
    expect(empty.storedVersion()).toBe(0);
  });

  it('非法快照载荷被拒绝且不落库', async () => {
    const db = snapshotRow(createEmptySnapshot(), 1);
    const cookie = await login(db);
    for (const snapshot of [null, 'nope', { app: 'other' }, { app: 'vita-log', schemaVersion: 99 }, { app: 'vita-log', schemaVersion: 1 }]) {
      const response = await callPut(db, { snapshot, expectedVersion: 1 }, { cookie });
      expect(response.status, JSON.stringify(snapshot)).toBe(400);
      expect((await response.json() as { code: string }).code).toBe('validation-failed');
    }
    expect(db.storedVersion()).toBe(1);
  });

  it('D1 未返回保存结果时按失败处理，不谎报保存成功', async () => {
    // A run() whose result carries no change count tells the Worker nothing
    // about whether the row moved. Reporting success there would tell the owner
    // their data is saved when it may not be, so it has to be a failure. Reads
    // keep working here, so the session resolves and the request genuinely
    // reaches the write rather than dying at the session lookup.
    const silent = new SqliteD1({ silentWrites: true });
    const sessionCookie = await login(silent);
    const response = await callPut(silent, { snapshot: createEmptySnapshot(), expectedVersion: 1 }, { cookie: sessionCookie });
    expect(response.status).toBe(503);
    expect((await response.json() as { code: string }).code).toBe('database-unavailable');
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
