import { describe, expect, it } from 'vitest';
import { createEmptySnapshot } from '../src/domain';
import {
  type HealthDataRepository,
  LocalStorageHealthRepository,
  type StorageLike,
} from '../src/storage';

class MemoryStorage implements StorageLike {
  private readonly values = new Map<string, string>();
  failWrites = false;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('quota exceeded');
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe('LocalStorageHealthRepository', () => {
  it('exposes the application-level health data repository contract', () => {
    const repository: HealthDataRepository = new LocalStorageHealthRepository(new MemoryStorage());

    expect(repository.load).toBeTypeOf('function');
    expect(repository.commit).toBeTypeOf('function');
  });

  it('returns a new empty snapshot when no data exists', async () => {
    const repository = new LocalStorageHealthRepository(new MemoryStorage());

    const result = await repository.load();

    expect(result.status).toBe('new');
    expect(result.snapshot.schemaVersion).toBe(1);
    expect(result.snapshot.weights).toEqual([]);
  });

  it('commits a snapshot and loads the same data after a new repository is created', async () => {
    const storage = new MemoryStorage();
    const first = new LocalStorageHealthRepository(storage);
    const snapshot = createEmptySnapshot('2026-09-28T00:00:00.000Z');
    snapshot.settings.name = 'Along';

    await first.commit(snapshot);
    const second = new LocalStorageHealthRepository(storage);
    const result = await second.load();

    expect(result.status).toBe('loaded');
    expect(result.snapshot.settings.name).toBe('Along');
    expect(result.snapshot.updatedAt).toBe('2026-09-28T00:00:00.000Z');
  });

  it('rejects malformed persisted data instead of treating it as empty', async () => {
    const storage = new MemoryStorage();
    storage.setItem('vita-log:snapshot', '{bad json');
    const repository = new LocalStorageHealthRepository(storage);

    await expect(repository.load()).rejects.toMatchObject({
      code: 'malformed',
    });
  });

  it('keeps the accepted snapshot when a later commit cannot be written', async () => {
    const storage = new MemoryStorage();
    const repository = new LocalStorageHealthRepository(storage);
    const original = createEmptySnapshot('2026-09-28T00:00:00.000Z');
    original.settings.name = 'Original';
    await repository.commit(original);

    storage.failWrites = true;
    const replacement = createEmptySnapshot('2026-09-29T00:00:00.000Z');
    replacement.settings.name = 'Replacement';

    await expect(repository.commit(replacement)).rejects.toMatchObject({
      code: 'write-failed',
    });
    storage.failWrites = false;
    const result = await repository.load();

    expect(result.snapshot.settings.name).toBe('Original');
  });
});
