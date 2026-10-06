import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { ApiError, SqliteStore, summarize } from './store';

export function createApi(store: SqliteStore, now: () => number = () => Date.now()): (request: Request) => Promise<Response> {
  const sessions = new Map<string, number>();
  let attempts = 0; let attemptWindow = 0;
  const cookie = (token: string, age: number): string => `vita-log-session=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${age}`;
  const json = (value: unknown, status = 200, headers: Record<string, string> = {}): Response =>
    Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
  return async request => {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      // No hostname allow-list here: the request layer must not assume a
      // loopback deployment, because the Cloudflare Pages Function serving the
      // same API answers on a public hostname. Every check below is relative to
      // the request's own origin. The self-hosted Node process keeps its
      // loopback-only posture at the listener (server/main.ts binds 127.0.0.1
      // and rejects a mismatched Host header before calling this handler).
      if (request.method !== 'GET' && path !== '/api/backups') {
        const origin = request.headers.get('origin');
        const site = request.headers.get('sec-fetch-site');
        if ((origin && origin !== url.origin) || site === 'cross-site') throw new ApiError('unauthorized', '拒绝跨站写入请求', 403);
        if (!request.headers.get('content-type')?.startsWith('application/json')) throw new ApiError('validation-failed', '请求必须使用 JSON');
      }
      const token = request.headers.get('cookie')?.match(/(?:^|;\s*)vita-log-session=([a-f0-9]+)/)?.[1] ?? '';
      const until = sessions.get(token) ?? 0;
      const loggedIn = until > now();
      for (const [key, expiry] of sessions) if (expiry <= now()) sessions.delete(key);
      const requireLogin = (): void => { if (!loggedIn) throw new ApiError('unauthorized', '编辑会话已失效，请重新登录', 401); };
      const body = async (): Promise<Record<string, unknown>> => {
        const raw = await request.text();
        if (Buffer.byteLength(raw) > 5 * 1024 * 1024) throw new ApiError('validation-failed', '请求超过 5 MiB 上限', 413);
        try { const value: unknown = JSON.parse(raw); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value as Record<string, unknown>; }
        catch { throw new ApiError('validation-failed', '请求不是有效 JSON'); }
      };
      // Neither public response says whether an owner is configured. That field
      // used to be here for a client branch that no longer exists, and leaving
      // it would turn these two anonymous GETs into a probe for "does this
      // deployment have an administrator" — on this backend only, since the
      // Worker deliberately withholds the same fact.
      if (path === '/api/health' && request.method === 'GET') return json({ storage: 'sqlite', empty: store.load().empty });
      if (path === '/api/session' && request.method === 'GET') return json({ loggedIn, until: loggedIn ? until : 0 });
      if (path === '/api/logout' && request.method === 'POST') { sessions.delete(token); return json({ loggedIn: false }, 200, { 'Set-Cookie': cookie('', 0) }); }
      if (path === '/api/login' && request.method === 'POST') {
        const data = await body();
        if (typeof data.username !== 'string' || typeof data.password !== 'string' || !data.username.trim() || data.username.length > 100 || data.password.length < 10 || data.password.length > 1024)
          throw new ApiError('validation-failed', '请填写账号和至少 10 字符的密码');
        if (now() - attemptWindow > 60_000) { attempts = 0; attemptWindow = now(); }
        if (++attempts > 10) throw new ApiError('unauthorized', '尝试次数过多，请一分钟后重试', 429);
        const auth = store.credentials();
        const candidate = scryptSync(data.password, auth?.salt ?? 'unconfigured', 64);
        if (!auth || auth.username !== data.username.trim() || !timingSafeEqual(candidate, Buffer.from(auth.hash, 'hex')))
          throw new ApiError('unauthorized', '账号或密码错误', 401);
        attempts = 0;
        const nextToken = randomBytes(32).toString('hex'); const nextUntil = now() + 30 * 60_000;
        sessions.delete(token); sessions.set(nextToken, nextUntil);
        return json({ loggedIn: true, until: nextUntil }, 200, { 'Set-Cookie': cookie(nextToken, 1800) });
      }
      if (path === '/api/snapshot' && request.method === 'GET') return json(store.load());
      requireLogin();
      if (path === '/api/recovery' && request.method === 'GET') return json({ snapshot: store.recovery() });
      if (path === '/api/backups' && request.method === 'GET') return json(store.backups());
      if (path === '/api/backups' && request.method === 'POST') return json({ name: store.backup() });
      if (path === '/api/migration-preview' && request.method === 'POST') {
        const data = await body();
        const { normalizeSnapshot } = await import('../src/domain');
        let snapshot;
        try { snapshot = normalizeSnapshot(data.snapshot); } catch { throw new ApiError('validation-failed', '浏览器快照校验失败'); }
        return json({ source: '浏览器迁移副本', empty: store.load().empty, summary: summarize(snapshot) });
      }
      if ((path === '/api/snapshot' && request.method === 'PUT') || (path === '/api/migrate' && request.method === 'POST')) {
        const data = await body();
        return json(store.commit(data.snapshot, Number(data.expectedVersion), data.destructive === true, path === '/api/migrate'));
      }
      if (path === '/api/restore' && request.method === 'POST') {
        const data = await body();
        if (typeof data.name !== 'string') throw new ApiError('validation-failed', '备份名称无效');
        return json(store.restore(data.name, Number(data.expectedVersion)));
      }
      return json({ code: 'validation-failed', message: '不存在的 API 路径' }, 404);
    } catch (error) {
      if (error instanceof ApiError) return json({ code: error.code, message: error.message }, error.status);
      return json({ code: 'database-unavailable', message: '数据库或备份不可用，未修改当前数据' }, 503);
    }
  };
}
