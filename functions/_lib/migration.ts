import { normalizeSnapshot, type DietRecord, type HealthSnapshot } from '../../src/domain';
import {
  D1UnavailableError,
  HealthStateVersionConflict,
  normalizeHealthSnapshot,
  prepareVersionedState,
  readStoredHealthState,
  type CommittedHealthState,
  type D1DatabaseLike,
} from './d1-store';

/**
 * First import of the owner's local snapshot into D1.
 *
 * This module owns only what the daily save path deliberately does not: the
 * empty-database guard, the preview, the reconciliation, and the atomicity of
 * the write. The row itself is built by `prepareVersionedState`, which is the
 * same helper `commitHealthState` uses, so the migrated row and a daily save
 * cannot end up shaped differently from the same snapshot and version.
 *
 * The daily save still cannot create this row. That asymmetry is the point:
 * `commitHealthState` refuses to create the online source of truth, and only a
 * deliberate, owner-confirmed import can.
 */

/** D1 already holds a snapshot: this import must not overwrite it. */
export class MigrationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationConflictError';
  }
}

/**
 * The one statement that both checks D1 is empty and creates the row.
 *
 * The guard is a `WHERE NOT EXISTS` on the same statement as the INSERT rather
 * than a `SELECT` followed by an `INSERT`. A separate check would leave a window
 * between the two in which a concurrent first import lands, and both would then
 * report success while only one row survives — a silent overwrite of exactly the
 * data this ticket exists to protect. In one statement D1 decides, so a lost
 * race reports zero changed rows and becomes a `migration-conflict` instead.
 *
 * `version` is bound rather than hard-coded as 1, from the same value the
 * reconciliation later compares against: a literal here and a computed
 * expectation there would drift the moment the version arithmetic changes, and
 * the drift would only surface *after* the row was stored. `saved_at` comes from
 * the same clock as the payload's `updatedAt`, so the first row is as versioned
 * and as timestamped as any row that follows it.
 */
export const MIGRATION_INSERT = 'INSERT INTO health_state (id, payload, version, saved_at) SELECT 1, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM health_state)';

/** Row count of the whole table, so "empty" means empty and not just "no id=1". */
export const HEALTH_STATE_COUNT_QUERY = 'SELECT COUNT(*) AS count FROM health_state';

/**
 * The candidate row, parked in a table no read path queries.
 *
 * Staging is what makes reconciliation mean anything. Reconciling a row that is
 * already the online snapshot would mean confirming data that visitors are being
 * served in the meantime — ADR-0002 requires that public read stays closed until
 * reconciliation and backup are done, and the only way to honour that is for the
 * unconfirmed bytes to live somewhere the public read path cannot reach.
 *
 * `INSERT OR REPLACE` rather than a guarded insert: this table is scratch space,
 * not the source of truth, so a retry after a failed attempt is supposed to
 * overwrite it. The guard belongs on the promotion, not here.
 */
export const MIGRATION_STAGE = 'INSERT OR REPLACE INTO health_state_import (id, payload, version, saved_at) VALUES (1, ?, ?, ?)';
export const MIGRATION_STAGE_CLEAR = 'DELETE FROM health_state_import WHERE id = 1';
/** Read the staged bytes back, the same columns the promotion will carry over. */
export const MIGRATION_STAGE_QUERY = 'SELECT payload, version, saved_at FROM health_state_import WHERE id = ?';

export type MigrationCollectionKey = 'weights' | 'measurements' | 'steps' | 'checkins' | 'diets';

export interface MigrationSummary {
  counts: Record<MigrationCollectionKey, number>;
  total: number;
  firstDate: string | null;
  lastDate: string | null;
  /** Totals across every diet record, so the owner can recognize their own data. */
  nutrition: { calorie: number; protein: number; fat: number; carb: number; sodium: number };
  settings: { name: string; heightCm: number; targetWeightKg: number; calorieTarget: number };
}

export interface MigrationPreview {
  /** Where the incoming data came from, so a mixed-up copy is visible. */
  source: string;
  /** Whether D1 can accept an import right now. */
  empty: boolean;
  summary: MigrationSummary;
}

export interface MigrationResult extends CommittedHealthState {
  summary: MigrationSummary;
}

const COLLECTIONS: Record<MigrationCollectionKey, (snapshot: HealthSnapshot) => Array<{ date: string }>> = {
  weights: (snapshot) => snapshot.weights,
  measurements: (snapshot) => snapshot.measurements,
  steps: (snapshot) => snapshot.steps,
  checkins: (snapshot) => snapshot.checkins,
  diets: (snapshot) => snapshot.diets,
};

/**
 * Summarize a snapshot for the owner to check before confirming an import.
 *
 * This counts records rather than trusting anything the caller sent, so the
 * numbers the owner approves are computed from the same snapshot the import will
 * write — not from a count the caller could have made up.
 */
export function summarizeMigration(snapshot: HealthSnapshot): MigrationSummary {
  const counts = Object.fromEntries(
    (Object.keys(COLLECTIONS) as MigrationCollectionKey[]).map((key) => [key, COLLECTIONS[key](snapshot).length]),
  ) as Record<MigrationCollectionKey, number>;

  const dates = (Object.keys(COLLECTIONS) as MigrationCollectionKey[])
    .flatMap((key) => COLLECTIONS[key](snapshot).map((record) => record.date))
    .sort();

  const nutrition = snapshot.diets.reduce(
    (sum, diet: DietRecord) => ({
      calorie: sum.calorie + diet.calorie,
      protein: sum.protein + diet.protein,
      fat: sum.fat + diet.fat,
      carb: sum.carb + diet.carb,
      sodium: sum.sodium + diet.sodium,
    }),
    { calorie: 0, protein: 0, fat: 0, carb: 0, sodium: 0 },
  );

  return {
    counts,
    total: dates.length,
    firstDate: dates[0] ?? null,
    lastDate: dates.at(-1) ?? null,
    nutrition,
    settings: {
      name: snapshot.settings.name,
      heightCm: snapshot.settings.heightCm,
      targetWeightKg: snapshot.settings.targetWeightKg,
      calorieTarget: snapshot.settings.calorieTarget,
    },
  };
}

/** Whether D1 holds no health row at all. */
export async function isD1Empty(db: D1DatabaseLike | undefined): Promise<boolean> {
  if (!db) throw new D1UnavailableError('D1 数据库绑定缺失');
  let row: Record<string, unknown> | null;
  try {
    row = await db.prepare(HEALTH_STATE_COUNT_QUERY).first<Record<string, unknown>>();
  } catch (error) {
    throw new D1UnavailableError('D1 数据库查询失败', { cause: error });
  }
  return Number(row?.count ?? 0) === 0;
}

/**
 * Describe an import without writing anything.
 *
 * Reads only: the caller can call this as often as it likes and D1 is unchanged
 * afterwards. That is what lets the page show the preview before the owner has
 * confirmed anything, and it is enforced by this function performing no write —
 * not by the route choosing not to call one.
 *
 * The snapshot is normalized here, before anything is counted. Without that the
 * preview would happily summarize a payload the import is about to reject — a
 * name of `12345`, a date of `not-a-date` — and the owner would be asked to
 * approve numbers that describe data D1 will never accept. A preview that cannot
 * lead to a successful import has no business being shown.
 */
export async function previewMigration(
  db: D1DatabaseLike | undefined,
  snapshot: HealthSnapshot,
  source: string,
): Promise<MigrationPreview> {
  // Normalize first: it raises `DomainError` on a payload the import would
  // reject, which is the same refusal the commit path gives — so the two cannot
  // disagree about whether this data is importable.
  const normalized = normalizeSnapshot(snapshot);
  return { source, empty: await isD1Empty(db), summary: summarizeMigration(normalized) };
}

/**
 * Import the snapshot into an empty D1.
 *
 * `expectedVersion` is the version the owner's preview reported — 0 for an empty
 * D1. It is checked rather than assumed so a confirmation built against a stale
 * preview is refused: between preview and confirm the database can change, and
 * an import that ignores that would write the owner's decision about one state
 * onto another. An empty D1 that is not version 0 means the preview no longer
 * describes reality; a non-empty one is a migration conflict.
 *
 * Refuses with `MigrationConflictError` when D1 already holds data — including
 * when it became non-empty between the preview and this call, because the guard
 * is inside the INSERT rather than in a check before it.
 *
 * After the row lands, it is read back and reconciled against what was sent. A
 * mismatch is reported rather than returned as a success: an import that cannot
 * be confirmed is not an import the owner can rely on, and the public read path
 * is already serving this row by then.
 *
 * The candidate is staged in `health_state_import`, reconciled there, and only
 * then promoted into `health_state` in one guarded statement. Staging is what
 * makes the contract below true rather than aspirational:
 *
 * - Every failure *before* the promotion — an invalid snapshot, a staging write
 *   that will not go in, a reconciliation mismatch, a stale preview, a database
 *   that cannot be reached — leaves the online snapshot exactly as it was. Since
 *   `health_state` is still empty, the public read path keeps answering
 *   "not imported yet" and a retry works normally. ADR-0002 requires that public
 *   read stays closed until reconciliation and backup are done, and reconciling
 *   bytes that were already being served could not satisfy that.
 * - The only failure that can land after the promotion is the final
 *   confirmation, whose window is a single read of a row this statement just
 *   wrote. Nothing rolls that row back: deleting the owner's only copy of their
 *   health data on a failed comparison would be the more destructive outcome, so
 *   the error says plainly that the data is live and to be read rather than
 *   re-imported.
 */
export async function commitMigration(
  db: D1DatabaseLike | undefined,
  snapshot: HealthSnapshot,
  expectedVersion: number,
  now: number,
): Promise<MigrationResult> {
  if (!db) throw new D1UnavailableError('D1 数据库绑定缺失');
  if (expectedVersion !== 0) {
    throw new HealthStateVersionConflict('迁移预览已过期，请重新预览后再确认');
  }

  // normalizeSnapshot throws on a payload the domain refuses, before any
  // statement runs, so a bad import cannot leave a partial row behind.
  const prepared = prepareVersionedState(snapshot, 0, now);

  // 1. Stage. The candidate goes into a table no read path ever queries, so it
  //    cannot become publicly visible while it is still unconfirmed. Staging is
  //    disposable: a retry replaces it, which is why this needs no empty guard.
  try {
    await db.prepare(MIGRATION_STAGE).bind(prepared.payload, prepared.version, prepared.savedAt).run();
  } catch (error) {
    throw new D1UnavailableError('D1 迁移写入失败', { cause: error });
  }

  // 2. Reconcile the staged bytes against what was sent. Until this passes, the
  //    online snapshot is still untouched — which is what keeps a failed import
  //    from changing the current D1 state and from opening public read on data
  //    nobody has confirmed.
  await reconcileMigration(db, prepared, 'staged');

  // 3. Promote. The empty-database guard lives inside this INSERT, so the check
  //    and the write are one statement and a concurrent first import cannot both
  //    report success.
  let changes: number | undefined;
  try {
    const result = await db.prepare(MIGRATION_INSERT).bind(prepared.payload, prepared.version, prepared.savedAt).run();
    changes = result?.meta?.changes;
  } catch (error) {
    throw new D1UnavailableError('D1 迁移写入失败', { cause: error });
  }

  if (changes === 0) throw new MigrationConflictError('D1 已有健康数据，已拒绝迁移；本导入不会覆盖线上数据');
  // An unreported change count is not a successful import, for the same reason
  // the save path refuses one: claiming success would tell the owner their data
  // is online when it may not be.
  if (changes === undefined) throw new D1UnavailableError('D1 未返回迁移结果');

  // 4. Confirm the promoted row, then clear the staging table. The summary the
  //    owner is shown is recomputed from D1's own bytes, never from the request.
  const promoted = await reconcileMigration(db, prepared, 'promoted');
  await clearStaging(db);
  return { version: promoted.version, savedAt: promoted.savedAt, summary: promoted.summary };
}

/** Drop the staged candidate once it has been promoted. */
async function clearStaging(db: D1DatabaseLike): Promise<void> {
  try {
    await db.prepare(MIGRATION_STAGE_CLEAR).run();
  } catch (error) {
    throw new D1UnavailableError('D1 迁移完成，但清理暂存数据失败', { cause: error });
  }
}

/**
 * Read a row back, prove it is what was sent, and report what is stored.
 *
 * Called twice: once against the staged candidate, before anything is promoted,
 * and once against the promoted row, so the promotion itself is confirmed rather
 * than assumed. The same comparison serves both because both rows are written
 * from the same `prepared` bytes.
 *
 * Three things are checked, each answering a different way the import could be
 * wrong while still reporting success:
 *
 * - the stored payload is byte-identical to the payload written, so no record
 *   was dropped or altered in transit. A summary comparison cannot stand in for
 *   this: a changed note, or a reordered field, leaves every count, date and
 *   nutrition total identical while still being different data.
 * - the version and timestamp are the ones this import stamped, so the first
 *   daily save after an import does not open with a version conflict on a row
 *   nobody else has touched.
 * - the stored payload still normalizes, so the public read path can serve it.
 *
 * `scope` only changes what the failure says, never what is checked. Before the
 * promotion the online snapshot is still empty, so the owner can simply retry;
 * after it, the data is live and must not be deleted on a failed comparison.
 */
async function reconcileMigration(
  db: D1DatabaseLike,
  prepared: { payload: string; savedAt: string; version: number },
  scope: 'staged' | 'promoted' = 'staged',
): Promise<{ version: number; savedAt: string; summary: MigrationSummary }> {
  const outcome = scope === 'staged'
    ? 'D1 尚未导入数据，可直接重试迁移'
    : '数据已写入 D1 并对外提供，请先查看当前数据再决定下一步';
  const fail = (detail: string): D1UnavailableError =>
    new D1UnavailableError(`D1 迁移对账失败：${detail}。${outcome}`);

  let stored: { payload: string; version: number; savedAt: string } | null;
  try {
    // The staged row is read with its own columns and mapped here, so both
    // sources hand the checks one shape instead of each comparison having to
    // know which query produced its row.
    if (scope === 'staged') {
      const row = await db.prepare(MIGRATION_STAGE_QUERY).bind(1).first<Record<string, unknown>>();
      stored = row
        ? { payload: String(row.payload), version: Number(row.version), savedAt: String(row.saved_at) }
        : null;
    } else {
      stored = await readStoredHealthState(db);
    }
  } catch (error) {
    throw fail('无法读回导入结果');
  }
  if (!stored) throw fail('读回结果为空');

  if (stored.payload !== prepared.payload) throw fail('写入内容与提交内容不一致');
  if (stored.version !== prepared.version) throw fail('版本与导入时不一致');
  if (stored.savedAt !== prepared.savedAt) throw fail('时间戳与导入时不一致');

  try {
    return { version: prepared.version, savedAt: prepared.savedAt, summary: summarizeMigration(normalizeHealthSnapshot(stored.payload)) };
  } catch (error) {
    throw fail('写入的快照无法识别');
  }
}