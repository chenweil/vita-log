import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmptySnapshot } from '../src/domain';
import { SqliteStore } from '../server/store';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function paths() { const root = mkdtempSync(join(tmpdir(), 'vita-sqlite-')); directories.push(root); return { database: join(root, 'data', 'vita.sqlite'), backups: join(root, 'backups') }; }

describe('SQLite snapshot repository', () => {
  it('persists a validated complete snapshot across process/store restart', () => {
    const locations = paths();
    const store = new SqliteStore(locations);
    expect(store.load().version).toBe(0);
    const snapshot = createEmptySnapshot(); snapshot.settings.name = 'Synthetic owner';
    store.commit(snapshot, 0); store.close();
    const restarted = new SqliteStore(locations);
    expect(restarted.load()).toMatchObject({ version: 1, snapshot: { settings: { name: 'Synthetic owner' } } });
    restarted.close();
  });

  it('rejects stale writes and protects the previous snapshot with recovery and backup', () => {
    const locations = paths();
    const store = new SqliteStore(locations);
    const first = createEmptySnapshot(); first.settings.name = 'First';
    store.commit(first, 0);
    const replacement = createEmptySnapshot(); replacement.settings.name = 'Replacement';
    expect(() => store.commit(replacement, 0)).toThrow('数据已更新');
    const committed = store.commit(replacement, 1);
    expect(committed.version).toBe(2);
    expect(store.recovery().settings.name).toBe('First');
    expect(store.backups().length).toBeGreaterThan(0);
    store.close();
  });

  it('refuses browser migration once SQLite contains data', () => {
    const locations = paths();
    const store = new SqliteStore(locations);
    store.commit(createEmptySnapshot(), 0);
    expect(() => store.commit(createEmptySnapshot(), 1, false, true)).toThrow('SQLite 已有数据');
    store.close();
  });
});
