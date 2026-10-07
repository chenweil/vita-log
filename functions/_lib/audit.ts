import { D1UnavailableError, type D1DatabaseLike } from './d1-store';

export type AuditOperation = 'save' | 'migrate' | 'backup' | 'restore';

export async function recordBackup(db: D1DatabaseLike | undefined, version: number, time: string): Promise<void> {
  if (!db) throw new D1UnavailableError('D1 数据库绑定缺失');
  try {
    const result = await db.prepare("INSERT INTO audit_event (time, operation, result, version) VALUES (?, 'backup', 'success', ?)").bind(time, version).run();
    if (result.meta.changes !== 1) throw new Error('unreported audit');
  } catch (error) { throw new D1UnavailableError('备份审计失败，未提供备份', { cause: error }); }
}

export async function readAudit(db: D1DatabaseLike | undefined): Promise<unknown[]> {
  if (!db) throw new D1UnavailableError('D1 数据库绑定缺失');
  try {
    const row = await db.prepare(`SELECT json_group_array(json_object('time', time, 'operation', operation, 'result', result, 'version', version)) AS events
      FROM (SELECT time, operation, result, version FROM audit_event ORDER BY id DESC LIMIT 100)`).first<{ events: string }>();
    return JSON.parse(row?.events ?? '[]') as unknown[];
  } catch (error) { throw new D1UnavailableError('审计读取失败', { cause: error }); }
}
