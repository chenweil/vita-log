import { D1BackupClient } from './d1-backup';

interface Fetcher { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> }

/** Same-origin HTTPS only; the cookie stays in memory and is explicitly revoked. */
export async function createOwnerBackupClient(originValue: string, credentials: { username: string; password: string }, client: Fetcher = globalThis): Promise<{ api: D1BackupClient; logout: () => Promise<void> }> {
  const origin = new URL(originValue);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('需要不带路径或凭据的 HTTPS origin');
  let cookie = '';
  const transport = {
    fetch: async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const url = new URL(String(input), origin);
      if (url.origin !== origin.origin) throw new Error('拒绝向其他域名发送本人会话');
      const headers = new Headers(init.headers);
      if (cookie) headers.set('cookie', cookie);
      if (init.method && init.method !== 'GET') { headers.set('origin', origin.origin); headers.set('host', origin.host); }
      const response = await client.fetch(url, { ...init, headers, cache: 'no-store', redirect: 'error' });
      const value = response.headers.get('set-cookie')?.match(/vita-log-session=([^;]*)/)?.[1];
      if (value !== undefined) cookie = value ? `vita-log-session=${value}` : '';
      return response;
    },
  };
  const loggedIn = await transport.fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: credentials.username, password: credentials.password }) });
  if (!loggedIn.ok || !cookie) throw new Error('登录失败，未执行备份或恢复');
  return {
    api: new D1BackupClient(transport),
    logout: async () => {
      const response = await transport.fetch('/api/logout', { method: 'POST' });
      if (!response.ok) throw new Error('操作已结束，但注销未确认；请在页面锁定或等待会话到期');
    },
  };
}
