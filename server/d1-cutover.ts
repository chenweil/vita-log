import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { isRecord, normalizeSnapshot, type HealthSnapshot } from '../src/domain';
import { summarizeMigration } from '../functions/_lib/migration';
import { persistBackup } from './d1-backup';
import { createOwnerBackupClient } from './d1-backup-transport';

type OwnerClient = Awaited<ReturnType<typeof createOwnerBackupClient>>;

/** Opening an absent source must never create a database or an empty snapshot. */
export function readCutoverSource(path: string): { snapshot: HealthSnapshot; version: number; sha256: string } {
  if (!lstatSync(path).isFile()) throw new Error('迁移来源必须是已有 SQLite 文件');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (db.prepare('PRAGMA user_version').get()?.user_version !== 1) throw new Error('SQLite schema 无法识别');
    const row = db.prepare('SELECT payload, version FROM state WHERE id = 1').get();
    if (!row || typeof row.payload !== 'string' || typeof row.version !== 'number' || !Number.isSafeInteger(row.version) || row.version < 1) throw new Error('SQLite 尚无可迁移快照');
    const snapshot = normalizeSnapshot(JSON.parse(row.payload));
    return { snapshot, version: row.version, sha256: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') };
  } finally { db.close(); }
}

export async function previewCutover(source: ReturnType<typeof readCutoverSource>, owner: OwnerClient) {
  const response = await owner.fetch('/api/migration-preview', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ snapshot: source.snapshot, source: '本机 SQLite' }),
  });
  if (!response.ok) throw new Error('在线迁移预览失败');
  const value: unknown = await response.json();
  const summary = summarizeMigration(source.snapshot);
  if (!isRecord(value) || typeof value.empty !== 'boolean' || !isDeepStrictEqual(value.summary, summary)) throw new Error('迁移预览对账不一致');
  return { empty: value.empty, sourceSha256: source.sha256, summary };
}

/** The owner freezes local writes and restricts public access before invoking this. */
export async function confirmCutover(source: ReturnType<typeof readCutoverSource>, directory: string, approvedSha256: string, owner: OwnerClient) {
  if (approvedSha256 !== source.sha256) throw new Error('来源已变化，请重新预览');
  const preview = await previewCutover(source, owner);
  if (!preview.empty) throw new Error('D1 已有健康数据，已停止首次迁移');
  const safety = persistBackup(directory, { snapshot: source.snapshot, version: source.version, exportedAt: new Date().toISOString() });
  const response = await owner.fetch('/api/migrate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ snapshot: source.snapshot, expectedVersion: 0 }),
  });
  if (!response.ok) throw new Error('迁移未确认成功；请先检查在线数据，不要盲目重试');
  const result: unknown = await response.json();
  if (!isRecord(result) || result.version !== 1 || typeof result.savedAt !== 'string' || !Number.isFinite(Date.parse(result.savedAt)) || !isDeepStrictEqual(result.summary, preview.summary)) throw new Error('迁移结果未确认；请先检查在线数据');
  const online = await owner.api.backup();
  // The server assigns updatedAt; every other field must survive byte-for-byte.
  if (online.version !== 1 || online.snapshot.updatedAt !== result.savedAt || !isDeepStrictEqual({ ...online.snapshot, updatedAt: source.snapshot.updatedAt }, source.snapshot)) throw new Error('已迁移，但在线副本对账未通过；保持访问隔离');
  const backup = persistBackup(directory, online);
  return { version: online.version, safety, backup, reconciled: true };
}
