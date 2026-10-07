import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isRecord, normalizeSnapshot, type HealthSnapshot } from '../src/domain';

interface Fetcher { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> }
export interface HealthBackup { snapshot: HealthSnapshot; version: number; exportedAt: string }
export interface BackupPaths { json: string; sqlite: string; version: number }

/** No fallback or retained version: every recovery explicitly names its expected version. */
export class D1BackupClient {
  constructor(private readonly client: Fetcher) {}
  async backup(): Promise<HealthBackup> {
    const response = await this.client.fetch('/api/backup', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('完整备份读取失败');
    const body: unknown = await response.json();
    if (!isRecord(body) || typeof body.version !== 'number' || !Number.isSafeInteger(body.version) || body.version < 0 || typeof body.exportedAt !== 'string' || !Number.isFinite(Date.parse(body.exportedAt))) throw new Error('备份响应无法识别');
    return { snapshot: normalizeSnapshot(body.snapshot), version: body.version, exportedAt: body.exportedAt };
  }
  async restore(snapshot: HealthSnapshot, expectedVersion: number): Promise<number> {
    const response = await this.client.fetch('/api/restore', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snapshot, expectedVersion }),
    });
    if (!response.ok) throw new Error(response.status === 409 ? '在线数据已更新，必须重新预览恢复' : '恢复未确认成功，请重新读取在线数据');
    const body: unknown = await response.json();
    if (!isRecord(body) || body.version !== expectedVersion + 1) throw new Error('恢复结果无法确认，请重新读取在线数据');
    return Number(body.version);
  }
}

const digest = (snapshot: HealthSnapshot): string => createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');

/** Writes both artifacts before returning; callers must not restore until this completes. */
export function persistBackup(directory: string, backup: HealthBackup): BackupPaths {
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const info = lstatSync(root);
  if (!info.isDirectory() || (info.mode & 0o777) !== 0o700) throw new Error('备份目录必须是权限为 0700 的真实目录');
  const name = `d1-${new Date(backup.exportedAt).toISOString().replaceAll(':', '-')}-${randomUUID()}`;
  const json = join(root, `${name}.backup.json`);
  const sqlite = join(root, `${name}.sqlite`);
  const snapshot = normalizeSnapshot(backup.snapshot);
  const descriptor = openSync(json, 'wx', 0o600);
  try {
    writeFileSync(descriptor, JSON.stringify({ ...snapshot, backup: { format: 'vita-log-d1-backup-v1', version: backup.version, exportedAt: backup.exportedAt, sha256: digest(snapshot) } }, null, 2));
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  closeSync(openSync(sqlite, 'wx', 0o600));
  const db = new DatabaseSync(sqlite);
  try {
    // Compatible with the existing offline SqliteStore, with no owner credential.
    db.exec(`PRAGMA synchronous=FULL;
      CREATE TABLE state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL, recovery TEXT, version INTEGER NOT NULL, saved_at TEXT NOT NULL);
      CREATE TABLE auth (id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL);
      PRAGMA user_version=1;`);
    db.prepare('INSERT INTO state (id, payload, recovery, version, saved_at) VALUES (1, ?, NULL, ?, ?)').run(JSON.stringify(snapshot), backup.version, snapshot.updatedAt);
  } finally { db.close(); }
  const sqliteDescriptor = openSync(sqlite, 'r');
  try { fsyncSync(sqliteDescriptor); } finally { closeSync(sqliteDescriptor); }
  const directoryDescriptor = openSync(root, 'r');
  try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
  return { json, sqlite, version: backup.version };
}

export const backupTo = async (directory: string, client: D1BackupClient): Promise<BackupPaths> => persistBackup(directory, await client.backup());

/** Validates the archived JSON before any online mutation is attempted. */
export function readBackupFile(path: string): HealthSnapshot {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(value) || !isRecord(value.backup) || value.backup.format !== 'vita-log-d1-backup-v1') throw new Error('不是有效的 D1 完整备份');
  const snapshot = normalizeSnapshot(value);
  if (value.backup.sha256 !== digest(snapshot)) throw new Error('备份内容校验失败');
  return snapshot;
}

/** The safety pair must be durably written before the version-checked restore POST. */
export async function restoreFromFile(file: string, directory: string, client: D1BackupClient, expectedVersion: number): Promise<{ version: number; safety: BackupPaths }> {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error('恢复需要明确的在线版本');
  const target = readBackupFile(file);
  const current = await client.backup();
  if (current.version !== expectedVersion) throw new Error('在线数据已更新，必须重新预览恢复');
  const safety = persistBackup(directory, current);
  return { version: await client.restore(target, expectedVersion), safety };
}
