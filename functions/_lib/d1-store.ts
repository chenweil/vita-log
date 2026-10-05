import { normalizeSnapshot, type HealthSnapshot } from '../../src/domain';

/**
 * The slice of the D1 API this app uses. Declared structurally so the
 * Pages runtime and the test fakes agree without adding a Workers type
 * dependency to the project.
 */
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta: { changes?: number } }>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1Statement;
}

/** D1 is unreachable, unbound, or holds a payload this app cannot read. */
export class D1UnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'D1UnavailableError';
  }
}

/** D1 is healthy but empty: the owner has not run the import yet. */
export class D1NotInitializedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'D1NotInitializedError';
  }
}

/** Another save landed first: the caller's expectedVersion is no longer current. */
export class HealthStateVersionConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HealthStateVersionConflict';
  }
}

export const HEALTH_STATE_QUERY = 'SELECT payload FROM health_state WHERE id = ?';
export const HEALTH_STATE_VERSION_QUERY = 'SELECT version FROM health_state WHERE id = ?';
/**
 * The optimistic-concurrency write.
 *
 * `version = ?` in the WHERE clause is what makes this safe: D1 reports how
 * many rows changed, and a save that lost the race changes none, so the caller
 * learns it is stale without a read-then-write gap in between. `saved_at` is
 * written from the same clock as the payload so the two cannot disagree.
 */
export const HEALTH_STATE_WRITE = 'UPDATE health_state SET payload = ?, saved_at = ? WHERE id = ? AND version = ?';

/**
 * Read the versioned snapshot D1 holds as the online source of truth.
 *
 * Fail-closed by construction: an unbound binding, a failed query, or an
 * unreadable payload all raise rather than returning an empty snapshot, so a
 * visitor can never mistake an outage for "there is no health data".
 *
 * Only `payload` is read. The row's `version` and `saved_at` columns exist for
 * the owner's write path (06.1-02a/03); this anonymous reader has no use for
 * them, and validating columns it never returns would let a cosmetic problem
 * turn a perfectly readable snapshot into an outage.
 */
export async function readHealthState(db: D1DatabaseLike | undefined): Promise<HealthSnapshot> {
  if (!db) throw new D1UnavailableError('D1 数据库绑定缺失');

  let row: Record<string, unknown> | null;
  try {
    row = await db.prepare(HEALTH_STATE_QUERY).bind(1).first<Record<string, unknown>>();
  } catch (error) {
    throw new D1UnavailableError('D1 数据库查询失败', { cause: error });
  }

  if (!row) throw new D1NotInitializedError('D1 尚未导入健康数据，请等待本人完成首次迁移');
  return decodeSnapshot(row.payload);
}

function decodeSnapshot(payload: unknown): HealthSnapshot {
  if (typeof payload !== 'string' || payload.length === 0) {
    throw new D1UnavailableError('D1 健康数据载荷缺失');
  }
  let value: unknown;
  try {
    value = JSON.parse(payload) as unknown;
  } catch (error) {
    throw new D1UnavailableError('D1 健康数据载荷不是有效 JSON', { cause: error });
  }
  try {
    return normalizeSnapshot(value);
  } catch (error) {
    throw new D1UnavailableError('D1 健康数据载荷无法识别', { cause: error });
  }
}

/** The current version D1 holds, or 0 when the row does not exist yet. */
export async function readHealthStateVersion(db: D1DatabaseLike | undefined): Promise<number> {
  if (!db) throw new D1UnavailableError('D1 数据库绑定缺失');
  let row: Record<string, unknown> | null;
  try {
    row = await db.prepare(HEALTH_STATE_VERSION_QUERY).bind(1).first<Record<string, unknown>>();
  } catch (error) {
    throw new D1UnavailableError('D1 数据库查询失败', { cause: error });
  }
  if (!row) return 0;
  const version = Number(row.version);
  if (!Number.isSafeInteger(version) || version < 0) throw new D1UnavailableError('D1 健康数据版本无效');
  return version;
}

export interface CommittedHealthState {
  version: number;
  savedAt: string;
}

/**
 * Commit a versioned snapshot, or report that the caller's version is stale.
 *
 * Returns the new version on success. Raises `HealthStateVersionConflict` when
 * the row moved on, and `D1UnavailableError` for every other failure — so a
 * transport or database problem can never be mistaken for a successful save.
 *
 * The saved snapshot is normalized before it is written, so what lands in D1 is
 * always a shape the public read path can project.
 */
export async function commitHealthState(
  db: D1DatabaseLike | undefined,
  snapshot: HealthSnapshot,
  expectedVersion: number,
  now: number,
): Promise<CommittedHealthState> {
  if (!db) throw new D1UnavailableError('D1 数据库绑定缺失');
  const savedAt = new Date(now).toISOString();
  const next: HealthSnapshot = { ...normalizeSnapshot(snapshot), updatedAt: savedAt };

  let changes: number | undefined;
  try {
    const result = await db.prepare(HEALTH_STATE_WRITE).bind(JSON.stringify(next), savedAt, 1, expectedVersion).run();
    changes = result?.meta?.changes;
  } catch (error) {
    throw new D1UnavailableError('D1 健康数据保存失败', { cause: error });
  }

  // Zero rows means the write did not land. That has two very different
  // causes, and the owner needs to be told which: the version moved on (retry
  // after reloading) versus there is no snapshot at all (the import has not
  // run). A daily save must never quietly create the online source of truth —
  // that is the migration's job, with its own empty-database guard.
  if (changes === 0) {
    const current = await readHealthStateVersion(db);
    if (current === 0 && !(await healthStateExists(db))) {
      throw new D1NotInitializedError('D1 尚未导入健康数据，请等待本人完成首次迁移');
    }
    throw new HealthStateVersionConflict('数据已更新，请重新加载；未提交输入已保留');
  }
  // Any other undefined count means D1 did not report the outcome, which is
  // also a failed write: claiming success here would tell the owner their data
  // is saved when it may not be.
  if (changes === undefined) throw new D1UnavailableError('D1 未返回保存结果');
  return { version: expectedVersion + 1, savedAt };
}

/** Whether D1 holds a health row at all. Used only on the failed-write path. */
async function healthStateExists(db: D1DatabaseLike): Promise<boolean> {
  try {
    return (await db.prepare(HEALTH_STATE_VERSION_QUERY).bind(1).first<Record<string, unknown>>()) !== null;
  } catch {
    return false;
  }
}
