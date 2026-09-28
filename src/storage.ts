import { createEmptySnapshot, normalizeSnapshot, type HealthSnapshot } from './domain';

export const SNAPSHOT_KEY = 'vita-log:snapshot';
export const RECOVERY_KEY = 'vita-log:recovery';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type LoadStatus = 'new' | 'loaded';

export interface LoadResult {
  snapshot: HealthSnapshot;
  status: LoadStatus;
}

export interface HealthDataRepository {
  load(): Promise<LoadResult>;
  commit(snapshot: HealthSnapshot): Promise<void>;
  loadRecovery(): Promise<HealthSnapshot>;
}

export type StorageErrorCode = 'read-failed' | 'malformed' | 'write-failed' | 'recovery-unavailable';

export class StorageError extends Error {
  constructor(public readonly code: StorageErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StorageError';
  }
}

export class LocalStorageHealthRepository implements HealthDataRepository {
  constructor(private readonly storage: StorageLike) {}

  async load(): Promise<LoadResult> {
    let raw: string | null;
    try {
      raw = this.storage.getItem(SNAPSHOT_KEY);
    } catch (error) {
      throw new StorageError('read-failed', '无法读取本地健康数据', { cause: error });
    }

    if (raw === null) {
      return { snapshot: createEmptySnapshot(), status: 'new' };
    }

    try {
      return { snapshot: normalizeSnapshot(JSON.parse(raw) as unknown), status: 'loaded' };
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError('malformed', '本地健康数据损坏，未将其当成空数据处理', { cause: error });
    }
  }

  async commit(snapshot: HealthSnapshot): Promise<void> {
    const normalized = normalizeSnapshot(snapshot);
    const serialized = JSON.stringify(normalized);
    let current: string | null;

    try {
      current = this.storage.getItem(SNAPSHOT_KEY);
      if (current !== null) this.storage.setItem(RECOVERY_KEY, current);
      this.storage.setItem(SNAPSHOT_KEY, serialized);
    } catch (error) {
      throw new StorageError('write-failed', '本地健康数据保存失败，已保留原快照', { cause: error });
    }
  }

  async loadRecovery(): Promise<HealthSnapshot> {
    let raw: string | null;
    try {
      raw = this.storage.getItem(RECOVERY_KEY);
    } catch (error) {
      throw new StorageError('read-failed', '无法读取本地恢复快照', { cause: error });
    }
    if (raw === null) throw new StorageError('recovery-unavailable', '当前没有可用的恢复快照');
    try {
      return normalizeSnapshot(JSON.parse(raw) as unknown);
    } catch (error) {
      throw new StorageError('malformed', '恢复快照损坏', { cause: error });
    }
  }
}
