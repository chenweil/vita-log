import { createEmptySnapshot, normalizeSnapshot, type HealthSnapshot } from './domain';

export const SNAPSHOT_KEY = 'vita-log:snapshot';
export const RECOVERY_KEY = 'vita-log:recovery';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type LoadStatus = 'new' | 'loaded';

/**
 * What a loaded snapshot is allowed to become.
 *
 * `owner` is the complete owner record, and the only thing that may be saved
 * back. `projection` is everything else the page may show but must never write:
 * the anonymous public view — which drops owner-only settings and carries no
 * version, so saving it would answer 200 while resetting them — and a published
 * snapshot file, which is complete but frozen and is not the source of truth.
 *
 * The page has to know which of the two it is holding rather than inferring it
 * from a version number it cannot see.
 */
export type SnapshotScope = 'owner' | 'projection';

export interface LoadResult {
  snapshot: HealthSnapshot;
  status: LoadStatus;
  scope: SnapshotScope;
}

export interface HealthDataRepository {
  load(): Promise<LoadResult>;
  commit(snapshot: HealthSnapshot): Promise<void>;
  loadRecovery(): Promise<HealthSnapshot>;
  /** Online backup/export re-authorizes at the server without changing the editor's version. */
  exportSnapshot?(): Promise<HealthSnapshot>;
  /**
   * Whether `commit` leaves the previous snapshot behind as one `loadRecovery`
   * can return.
   *
   * A repository that does not keep one must not get its restore control
   * enabled just because a save succeeded: the promise that a cleared record is
   * recoverable has to be backed by something that can actually recover it.
   */
  readonly keepsRecoveryPoint: boolean;
}

export type StorageErrorCode = 'read-failed' | 'malformed' | 'write-failed' | 'recovery-unavailable' | 'database-unavailable' | 'unauthorized' | 'version-conflict' | 'validation-failed' | 'migration-conflict' | 'backup-failed';

export class StorageError extends Error {
  /** A server can use unauthorized for both 401 and 429; preserve the distinction. */
  readonly httpStatus?: number;
  constructor(public readonly code: StorageErrorCode, message: string, options?: { cause?: unknown; httpStatus?: number }) {
    super(message, options);
    this.name = 'StorageError';
    this.httpStatus = options?.httpStatus;
  }
}

export class LocalStorageHealthRepository implements HealthDataRepository {
  /** `commit` moves the current snapshot into `RECOVERY_KEY` before overwriting. */
  readonly keepsRecoveryPoint = true;

  constructor(private readonly storage: StorageLike) {}

  async load(): Promise<LoadResult> {
    let raw: string | null;
    try {
      raw = this.storage.getItem(SNAPSHOT_KEY);
    } catch (error) {
      throw new StorageError('read-failed', '无法读取本地健康数据', { cause: error });
    }

    if (raw === null) {
      return { snapshot: createEmptySnapshot(), status: 'new', scope: 'owner' };
    }

    try {
      return { snapshot: normalizeSnapshot(JSON.parse(raw) as unknown), status: 'loaded', scope: 'owner' };
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
