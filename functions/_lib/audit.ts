import { D1UnavailableError, type D1DatabaseLike } from './d1-store';
import { auditRetentionStatement } from './audit-policy';

export type AuditOperation = 'save' | 'migrate' | 'backup' | 'restore';
export type AuditKind = 'write' | 'backup' | 'all';
interface AuditEvent { time: string; operation: AuditOperation; result: string; version: number }
interface AuditRow extends AuditEvent { id: number }

export async function recordBackup(db: D1DatabaseLike | undefined, version: number, time: string): Promise<void> {
  if (!db) throw new D1UnavailableError('D1 数据库绑定缺失');
  try {
    if (!db.batch) throw new Error('D1 transaction support missing');
    const [result] = await db.batch([
      db.prepare("INSERT INTO audit_event (time, operation, result, version) VALUES (?, 'backup', 'success', ?)").bind(time, version),
      auditRetentionStatement(db),
    ]);
    if (result.meta.changes !== 1) throw new Error('unreported audit');
  } catch (error) { throw new D1UnavailableError('备份审计失败，未提供备份', { cause: error }); }
}

export async function readAudit(db: D1DatabaseLike | undefined, before: number | null = null, kind: AuditKind = 'write'): Promise<{ events: AuditEvent[]; nextCursor: string | null }> {
  if (!db) throw new D1UnavailableError('D1 数据库绑定缺失');
  try {
    const row = await db.prepare(`SELECT json_group_array(json_object('id', id, 'time', time, 'operation', operation, 'result', result, 'version', version)) AS events
      FROM (SELECT id, time, operation, result, version FROM audit_event
        WHERE (? IS NULL OR id < ?) AND (? = 'all' OR (? = 'backup' AND operation = 'backup') OR (? = 'write' AND operation <> 'backup'))
        ORDER BY id DESC LIMIT 101)`).bind(before, before, kind, kind, kind).first<{ events: string }>();
    const rows = JSON.parse(row?.events ?? '[]') as AuditRow[];
    const page = rows.slice(0, 100);
    return {
      events: page.map(({ time, operation, result, version }) => ({ time, operation, result, version })),
      nextCursor: rows.length > 100 ? String(page[99].id) : null,
    };
  } catch (error) { throw new D1UnavailableError('审计读取失败', { cause: error }); }
}
