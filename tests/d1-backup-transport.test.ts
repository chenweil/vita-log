import { expect, it } from 'vitest';
import { createEmptySnapshot } from '../src/domain';
import { createOwnerCredential } from '../functions/_lib/owner-credentials';
import { SqliteD1 } from './support/sqlite-d1';
import { createOwnerBackupClient } from '../server/d1-backup-transport';
import { onRequestPost as login } from '../functions/api/login';
import { onRequestPost as logout } from '../functions/api/logout';
import { onRequestGet as backup } from '../functions/api/backup';
import { onRequestPost as restore } from '../functions/api/restore';
import { clearRateLimits } from '../functions/_lib/rate-limit';

it('运维客户端自己登录、传递安全 Cookie、同源恢复并确认注销', async () => {
  clearRateLimits();
  const db = new SqliteD1();
  const password = 'a sufficiently long owner password';
  const env = { VITA_LOG_DB: db, VITA_LOG_OWNER_USERNAME: 'owner', VITA_LOG_OWNER_CREDENTIAL: await createOwnerCredential(password) };
  db.seed(JSON.stringify(createEmptySnapshot()), 4);
  const routes = { '/api/login': login, '/api/logout': logout, '/api/backup': backup, '/api/restore': restore };
  const client = await createOwnerBackupClient('https://vita-log.pages.dev', { username: 'owner', password }, {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname as keyof typeof routes;
      return routes[path]({ request, env });
    },
  });
  try {
    expect((await client.api.backup()).version).toBe(4);
    const target = createEmptySnapshot();
    target.settings.name = 'restored';
    expect(await client.api.restore(target, 4)).toBe(5);
    expect((await client.api.backup()).snapshot.settings.name).toBe('restored');
    await client.logout();
    await expect(client.api.backup()).rejects.toThrow('读取失败');
  } finally { db.close(); clearRateLimits(); }
});
