import { describe, expect, it } from 'vitest';
import { createEmptySnapshot } from '../src/domain';
import { SqliteHealthRepository } from '../src/sqlite-storage';
import { ServerEditorAuth } from '../src/server-auth';

class FakeClient {
  calls: Array<{ input: string; init?: RequestInit }> = [];
  responses: Response[] = [];
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> { this.calls.push({ input: String(input), init }); return Promise.resolve(this.responses.shift() ?? Response.json({})); }
}

describe('SQLite browser adapters', () => {
  it('uses the repository contract and carries the server version on writes', async () => {
    const client = new FakeClient();
    client.responses.push(Response.json({ snapshot: createEmptySnapshot(), version: 4, empty: false }));
    client.responses.push(Response.json({ snapshot: createEmptySnapshot(), version: 5, empty: false }));
    const repository = new SqliteHealthRepository(client);
    await repository.load();
    await repository.commit(createEmptySnapshot());
    expect(client.calls[1].init?.body).toContain('"expectedVersion":4');
  });

  it('sets and clears a server editor session through the public auth boundary', async () => {
    const client = new FakeClient();
    client.responses.push(Response.json({ configured: false, loggedIn: false, until: 0 }));
    client.responses.push(Response.json({ until: 60_000 }));
    const auth = new ServerEditorAuth(client, () => 1_000);
    expect(await auth.unlock('owner', 'long-password')).toBe(true);
    expect(auth.isUnlocked()).toBe(true);
    await auth.lock();
    expect(auth.isUnlocked()).toBe(false);
    expect(client.calls[2].input).toBe('/api/logout');
  });

  it('previews migration details and restores a selected backup through the API', async () => {
    const client = new FakeClient();
    client.responses.push(Response.json({ snapshot: createEmptySnapshot(), version: 3, empty: false }));
    client.responses.push(Response.json({ source: '浏览器迁移副本', empty: true, summary: { total: 0, firstDate: null, lastDate: null, counts: {}, settings: { name: '', heightCm: 164, targetWeightKg: 68 } } }));
    client.responses.push(Response.json([{ name: 'manual-one.sqlite', createdAt: '2026-10-05T00:00:00.000Z', summary: { total: 0, firstDate: null, lastDate: null, settings: { name: 'Smoke', heightCm: 164, targetWeightKg: 68 } } }]));
    client.responses.push(Response.json({ snapshot: createEmptySnapshot(), version: 4, empty: false }));
    const repository = new SqliteHealthRepository(client);
    await repository.load();
    expect((await repository.previewMigration(createEmptySnapshot())).summary.settings.heightCm).toBe(164);
    expect((await repository.listBackups())[0].name).toBe('manual-one.sqlite');
    await repository.restore('manual-one.sqlite');
    expect(client.calls.at(-1)?.init?.body).toContain('manual-one.sqlite');
  });
});
