import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmptySnapshot } from '../src/domain';
import { createApi } from '../server/api';
import { SqliteStore } from '../server/store';

function setup() { const root = mkdtempSync(join(tmpdir(), 'vita-api-')); const store = new SqliteStore({ database: join(root, 'data.sqlite'), backups: join(root, 'backups') }); return { root, store, api: createApi(store, () => 1_000_000) }; }
async function request(api: ReturnType<typeof createApi>, path: string, init?: RequestInit) { return api(new Request(`http://127.0.0.1${path}`, init)); }

describe('SQLite API boundary', () => {
  it('requires auth for writes and rejects stale versions', async () => {
    const { root, store, api } = setup();
    try {
      const denied = await request(api, '/api/snapshot', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshot: createEmptySnapshot(), expectedVersion: 0 }) });
      expect(denied.status).toBe(401);
      const setupResponse = await request(api, '/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'long-enough-password' }) });
      expect(setupResponse.status).toBe(200);
      const cookie = setupResponse.headers.get('set-cookie');
      const stale = await request(api, '/api/snapshot', { method: 'PUT', headers: { 'content-type': 'application/json', cookie: cookie ?? '' }, body: JSON.stringify({ snapshot: createEmptySnapshot(), expectedVersion: 99 }) });
      expect(stale.status).toBe(409);
      const backup = await request(api, '/api/backups', { method: 'POST', headers: { cookie: cookie ?? '' } });
      expect(backup.status).toBe(200);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
