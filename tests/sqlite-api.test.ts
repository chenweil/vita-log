import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes, scryptSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmptySnapshot } from '../src/domain';
import { createApi } from '../server/api';
import { SqliteStore } from '../server/store';

function setup() { const root = mkdtempSync(join(tmpdir(), 'vita-api-')); const store = new SqliteStore({ database: join(root, 'data.sqlite'), backups: join(root, 'backups') }); return { root, store, api: createApi(store, () => 1_000_000) }; }
/** Provision the owner offline, the way `npm run owner` does, then log in. There is no setup route to lean on any more. */
async function ownerSession(api: ReturnType<typeof createApi>, store: SqliteStore, username: string, password: string) {
  const salt = randomBytes(16).toString('hex');
  store.setOwnerCredentials(username, salt, scryptSync(password, salt, 64).toString('hex'));
  return api(new Request('http://127.0.0.1/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) }));
}
async function request(api: ReturnType<typeof createApi>, path: string, init?: RequestInit) { return api(new Request(`http://127.0.0.1${path}`, init)); }
async function requestFrom(api: ReturnType<typeof createApi>, origin: string, path: string, init?: RequestInit) { return api(new Request(`${origin}${path}`, init)); }

describe('SQLite API boundary', () => {
  it('requires auth for writes and rejects stale versions', async () => {
    const { root, store, api } = setup();
    try {
      const denied = await request(api, '/api/snapshot', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshot: createEmptySnapshot(), expectedVersion: 0 }) });
      expect(denied.status).toBe(401);
      const login = await ownerSession(api, store, 'owner', 'long-enough-password');
      expect(login.status).toBe(200);
      const cookie = login.headers.get('set-cookie');
      const stale = await request(api, '/api/snapshot', { method: 'PUT', headers: { 'content-type': 'application/json', cookie: cookie ?? '' }, body: JSON.stringify({ snapshot: createEmptySnapshot(), expectedVersion: 99 }) });
      expect(stale.status).toBe(409);
      const backup = await request(api, '/api/backups', { method: 'POST', headers: { cookie: cookie ?? '' } });
      expect(backup.status).toBe(200);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('不以 loopback hostname 白名单拒绝请求，但写入仍要求同源', async () => {
    const { root, store, api } = setup();
    try {
      // The request layer must work on a Cloudflare public hostname; the
      // loopback-only posture of the self-hosted process lives in the listener.
      const publicRead = await requestFrom(api, 'https://vita-log.pages.dev', '/api/snapshot');
      expect(publicRead.status).toBe(200);

      const crossSite = await requestFrom(api, 'https://vita-log.pages.dev', '/api/snapshot', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
        body: JSON.stringify({ snapshot: createEmptySnapshot(), expectedVersion: 0 }),
      });
      expect(crossSite.status).toBe(403);
      expect((await crossSite.json() as { code: string }).code).toBe('unauthorized');
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
