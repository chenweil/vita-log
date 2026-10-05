import { normalizeSnapshot, type HealthSnapshot } from '../../src/domain';

/**
 * The slice of the D1 API this app uses. Declared structurally so the
 * Pages runtime and the test fakes agree without adding a Workers type
 * dependency to the project.
 */
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
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

export const HEALTH_STATE_QUERY = 'SELECT payload FROM health_state WHERE id = ?';

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
