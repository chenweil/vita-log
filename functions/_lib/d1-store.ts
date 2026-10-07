import { normalizeSnapshot, type HealthSnapshot } from '../../src/domain';
import type { AuditOperation } from './audit';

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
  batch?(statements: D1Statement[]): Promise<Array<{ meta: { changes?: number } }>>;
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
export const HEALTH_STATE_QUERY_FULL = 'SELECT payload, version, saved_at FROM health_state WHERE id = ?';
/**
 * The optimistic-concurrency write.
 *
 * `version = ?` in the WHERE clause is what makes this safe: D1 reports how
 * many rows changed, and a save that lost the race changes none, so the caller
 * learns it is stale without a read-then-write gap in between.
 *
 * The SET clause has to advance `version` too, and that is not bookkeeping.
 * Without it the stored version never changes, so every later write still
 * matches the first one and the WHERE clause can never fire — two tabs would
 * both save, both get 200, and one edit would vanish. The new value is computed
 * here, in the same statement that checks the old one, so there is no window
 * between "this is the current version" and "this becomes the next version".
 *
 * `saved_at` is written from the same clock as the payload, so the two cannot
 * disagree.
 */
export const HEALTH_STATE_WRITE = 'UPDATE health_state SET payload = ?, saved_at = ?, version = ? WHERE id = ? AND version = ?';

/** Admission and the health UPDATE run in one batch transaction. No payload is logged. */
const AUDIT_WRITE = `INSERT INTO audit_event (time, operation, result, version)
  SELECT ?, ?, CASE
    WHEN EXISTS (SELECT 1 FROM health_state WHERE id = 1 AND version = ?) THEN 'success'
    WHEN EXISTS (SELECT 1 FROM health_state WHERE id = 1) THEN 'version-conflict'
    ELSE 'database-unavailable' END,
  CASE WHEN EXISTS (SELECT 1 FROM health_state WHERE id = 1 AND version = ?) THEN ? ELSE ? END`;

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

/** The raw payload, version and timestamp of the single health row. */
export interface StoredHealthState {
  payload: string;
  version: number;
  savedAt: string;
}

/** Read payload and its concurrency version from the same D1 row/query. */
export async function readOwnerHealthState(db: D1DatabaseLike | undefined): Promise<{ snapshot: HealthSnapshot; version: number }> {
  const stored = await readStoredHealthState(db);
  return { snapshot: decodeSnapshot(stored.payload), version: stored.version };
}

/**
 * Read the row as stored, without interpreting the payload.
 *
 * The migration reconciliation needs the row exactly as D1 holds it: it compares
 * the stored payload against the payload it meant to write, and decoding first
 * would destroy the evidence of what was actually stored. A payload D1 cannot
 * read raises here, as everywhere else, rather than decoding to something
 * plausible.
 */
export async function readStoredHealthState(db: D1DatabaseLike | undefined): Promise<StoredHealthState> {
  if (!db) throw new D1UnavailableError('D1 数据库绑定缺失');
  let row: Record<string, unknown> | null;
  try {
    row = await db.prepare(HEALTH_STATE_QUERY_FULL).bind(1).first<Record<string, unknown>>();
  } catch (error) {
    throw new D1UnavailableError('D1 数据库查询失败', { cause: error });
  }
  if (!row) throw new D1NotInitializedError('D1 尚未导入健康数据，请等待本人完成首次迁移');
  if (typeof row.payload !== 'string' || row.payload.length === 0) throw new D1UnavailableError('D1 健康数据载荷缺失');
  if (!Number.isSafeInteger(row.version) || Number(row.version) < 0) throw new D1UnavailableError('D1 健康数据版本无效');
  if (typeof row.saved_at !== 'string' || row.saved_at.length === 0) throw new D1UnavailableError('D1 健康数据时间戳缺失');
  return { payload: row.payload, version: Number(row.version), savedAt: row.saved_at };
}

/** Decode a stored payload, raising rather than falling back to empty data. */
export function normalizeHealthSnapshot(payload: unknown): HealthSnapshot {
  return decodeSnapshot(payload);
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

export interface PreparedVersionedState extends CommittedHealthState {
  payload: string;
}

/**
 * Turn a snapshot plus the version the caller believes D1 holds into the exact
 * row contents and the next version.
 *
 * This is the shared half of every write to `health_state`, and it is shared on
 * purpose: the daily save (an UPDATE) and the first import (an INSERT) differ
 * only in which statement carries these values. Keeping the arithmetic and the
 * payload normalization in one place is what stops the two paths from drifting
 * into computing different rows from the same snapshot and the same version.
 *
 * `updatedAt` and `saved_at` come from the same clock, so the snapshot can never
 * claim to have been saved at a time its own row disagrees with.
 */
export function prepareVersionedState(
  snapshot: HealthSnapshot,
  expectedVersion: number,
  now: number,
): PreparedVersionedState {
  const savedAt = new Date(now).toISOString();
  const next: HealthSnapshot = { ...normalizeSnapshot(snapshot), updatedAt: savedAt };
  return { payload: JSON.stringify(next), savedAt, version: expectedVersion + 1 };
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
  operation: AuditOperation = 'save',
): Promise<CommittedHealthState> {
  if (!db) throw new D1UnavailableError('D1 数据库绑定缺失');
  const { payload, savedAt, version: nextVersion } = prepareVersionedState(snapshot, expectedVersion, now);

  let changes: number | undefined;
  try {
    if (!db.batch) throw new Error('D1 transaction support missing');
    const [, result] = await db.batch([
      db.prepare(AUDIT_WRITE).bind(savedAt, operation, expectedVersion, expectedVersion, nextVersion, expectedVersion),
      db.prepare(HEALTH_STATE_WRITE).bind(payload, savedAt, nextVersion, 1, expectedVersion),
    ]);
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
  return { version: nextVersion, savedAt };
}

/** Whether D1 holds a health row at all. Used only on the failed-write path. */
async function healthStateExists(db: D1DatabaseLike): Promise<boolean> {
  try {
    return (await db.prepare(HEALTH_STATE_VERSION_QUERY).bind(1).first<Record<string, unknown>>()) !== null;
  } catch {
    return false;
  }
}
