import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createEmptySnapshot, normalizeSnapshot, type HealthSnapshot } from '../src/domain';

export type ApiErrorCode = 'unauthorized' | 'version-conflict' | 'validation-failed' | 'database-unavailable' | 'migration-conflict' | 'backup-failed' | 'recovery-unavailable';
export class ApiError extends Error {
  constructor(public readonly code: ApiErrorCode, message: string, public readonly status = 400) { super(message); }
}
export interface StorePaths { database: string; backups: string }
export interface StoredSnapshot { snapshot: HealthSnapshot; version: number; empty: boolean }
export interface SnapshotSummary {
  counts: Record<string, number>; total: number; firstDate: string | null; lastDate: string | null;
  settings: { name: string; heightCm: number; targetWeightKg: number };
}
export function summarize(snapshot: HealthSnapshot): SnapshotSummary {
  const collections = { weights: snapshot.weights, measurements: snapshot.measurements, steps: snapshot.steps, checkins: snapshot.checkins, diets: snapshot.diets };
  const counts = Object.fromEntries(Object.entries(collections).map(([key, records]) => [key, records.length]));
  const dates = Object.values(collections).flat().map(record => record.date).sort();
  return { counts, total: dates.length, firstDate: dates[0] ?? null, lastDate: dates.at(-1) ?? null,
    settings: { name: snapshot.settings.name, heightCm: snapshot.settings.heightCm, targetWeightKg: snapshot.settings.targetWeightKg } };
}

export class SqliteStore {
  private readonly db: DatabaseSync;
  constructor(private readonly paths: StorePaths, private readonly now: () => Date = () => new Date()) {
    const existed = existsSync(paths.database);
    mkdirSync(dirname(paths.database), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(paths.database);
    chmodSync(paths.database, 0o600);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
    try {
      const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
      if (version > 1) throw new ApiError('migration-conflict', '数据库版本比应用更新，已停止写入');
      if (version === 0) {
        const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        if (existed && tables.length === 0 && statSync(paths.database).size > 0) throw new ApiError('migration-conflict', '无法识别旧数据库结构，已停止写入');
        if (tables.length) throw new ApiError('migration-conflict', '无法识别旧数据库结构，已停止写入');
        // Existing SQLite files are backed up before any forward schema migration.
        if (existed && statSync(paths.database).size > 0) this.backup('schema');
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL, recovery TEXT, version INTEGER NOT NULL, saved_at TEXT NOT NULL);
          CREATE TABLE auth (id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL);
          PRAGMA user_version=1; COMMIT;`);
      }
      this.load();
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  load(): StoredSnapshot {
    const row = this.db.prepare('SELECT payload, version FROM state WHERE id=1').get();
    if (!row) return { snapshot: createEmptySnapshot(this.now().toISOString()), version: 0, empty: true };
    return { snapshot: normalizeSnapshot(JSON.parse(String(row.payload)) as unknown), version: Number(row.version), empty: false };
  }
  recovery(): HealthSnapshot {
    const row = this.db.prepare('SELECT recovery FROM state WHERE id=1').get();
    if (!row?.recovery) throw new ApiError('recovery-unavailable', '没有可用恢复快照', 404);
    return normalizeSnapshot(JSON.parse(String(row.recovery)) as unknown);
  }
  credentials(): { username: string; salt: string; hash: string } | null {
    const row = this.db.prepare('SELECT username,salt,hash FROM auth WHERE id=1').get();
    return row ? { username: String(row.username), salt: String(row.salt), hash: String(row.hash) } : null;
  }
  setup(username: string, salt: string, hash: string): void {
    try { this.db.prepare('INSERT INTO auth(id,username,salt,hash) VALUES(1,?,?,?)').run(username, salt, hash); }
    catch { throw new ApiError('migration-conflict', '本人账号已经设置', 409); }
  }
  /**
   * Provision or rotate the owner account. Ops-only.
   *
   * `setup` above refuses a second account on purpose, so the one-time bootstrap
   * cannot be replayed. Rotation is a different act with a different
   * authorization — it has to be something the owner runs deliberately — so it
   * gets its own method rather than weakening `setup`. Nothing in the request
   * path calls this: the API has no route that could.
   */
  setOwnerCredentials(username: string, salt: string, hash: string): void {
    this.db.prepare('UPDATE auth SET username=?, salt=?, hash=? WHERE id=1').run(username, salt, hash);
    const updated = this.db.prepare('SELECT COUNT(*) AS count FROM auth WHERE id=1').get() as { count?: number };
    if (Number(updated?.count ?? 0) === 1) return;
    this.db.prepare('INSERT INTO auth(id,username,salt,hash) VALUES(1,?,?,?)').run(username, salt, hash);
  }
  commit(value: unknown, expectedVersion: number, destructive = false, migration = false): StoredSnapshot {
    let snapshot: HealthSnapshot;
    try { snapshot = normalizeSnapshot(value); } catch { throw new ApiError('validation-failed', '健康快照校验失败'); }
    const current = this.load();
    if (migration && !current.empty) throw new ApiError('migration-conflict', 'SQLite 已有数据，请使用明确的导入流程', 409);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== current.version) throw new ApiError('version-conflict', '数据已更新，请重新加载；未提交输入已保留', 409);
    const day = this.now().toISOString().slice(0, 10);
    const dailyExists = existsSync(this.paths.backups) && readdirSync(this.paths.backups).some(name => name.startsWith(`daily-${day}-`) && name.endsWith('.sqlite'));
    if (!dailyExists) this.backup('daily');
    if (destructive) this.backup('safety');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const latest = this.load();
      if (latest.version !== expectedVersion) throw new ApiError('version-conflict', '数据已更新，请重新加载；未提交输入已保留', 409);
      if (migration && !latest.empty) throw new ApiError('migration-conflict', 'SQLite 已有数据', 409);
      snapshot.updatedAt = this.now().toISOString();
      this.db.prepare(`INSERT INTO state(id,payload,recovery,version,saved_at) VALUES(1,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,recovery=excluded.recovery,version=excluded.version,saved_at=excluded.saved_at`)
        .run(JSON.stringify(snapshot), latest.empty ? null : JSON.stringify(latest.snapshot), expectedVersion + 1, snapshot.updatedAt);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.load();
  }
  backup(kind: 'manual' | 'daily' | 'safety' | 'schema' = 'manual'): string {
    const name = `${kind}-${this.now().toISOString().slice(0, 10)}-${this.now().getTime()}-${randomUUID()}.sqlite`;
    const path = join(this.paths.backups, name);
    const temporary = `${path}.tmp`;
    try {
      mkdirSync(this.paths.backups, { recursive: true, mode: 0o700 });
      // VACUUM INTO creates a consistent SQLite database, including with an active writer.
      this.db.exec(`VACUUM INTO '${temporary.replaceAll("'", "''")}'`);
      chmodSync(temporary, 0o600);
      renameSync(temporary, path);
    } catch { rmSync(temporary, { force: true }); throw new ApiError('backup-failed', '数据库备份失败，已停止写入', 503); }
    if (kind === 'daily') {
      const daily = readdirSync(this.paths.backups).filter(file => file.startsWith('daily-') && file.endsWith('.sqlite')).sort().reverse();
      for (const old of daily.slice(30)) rmSync(join(this.paths.backups, old));
    }
    return name;
  }
  backups(): Array<{ name: string; createdAt: string; summary: SnapshotSummary }> {
    if (!existsSync(this.paths.backups)) return [];
    return readdirSync(this.paths.backups).filter(name => name.endsWith('.sqlite')).sort().reverse().map(name => {
      const snapshot = this.readBackup(name);
      return { name, createdAt: statSync(join(this.paths.backups, name)).mtime.toISOString(), summary: summarize(snapshot) };
    });
  }
  readBackup(name: string): HealthSnapshot {
    if (!/^(manual|daily|safety|schema)-[\w.-]+\.sqlite$/.test(name)) throw new ApiError('validation-failed', '备份名称无效');
    const db = new DatabaseSync(join(this.paths.backups, name), { readOnly: true });
    try {
      if (Number(db.prepare('PRAGMA user_version').get()?.user_version) !== 1) throw new ApiError('validation-failed', '备份数据库版本无效');
      const row = db.prepare('SELECT payload FROM state WHERE id=1').get();
      return row ? normalizeSnapshot(JSON.parse(String(row.payload)) as unknown) : createEmptySnapshot();
    } finally { db.close(); }
  }
  restore(name: string, expectedVersion: number): StoredSnapshot {
    return this.commit(this.readBackup(name), expectedVersion, true);
  }
}
