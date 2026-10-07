import type { D1DatabaseLike, D1Statement } from './d1-store';

/** Bounded metadata retention; backup clicks never evict health-write history. */
export const WRITE_AUDIT_LIMIT = 10_000;
export const BACKUP_AUDIT_LIMIT = 1_000;

export function auditRetentionStatement(db: D1DatabaseLike): D1Statement {
  return db.prepare(`DELETE FROM audit_event WHERE
    (operation <> 'backup' AND id NOT IN (SELECT id FROM audit_event WHERE operation <> 'backup' ORDER BY id DESC LIMIT ?)) OR
    (operation = 'backup' AND id NOT IN (SELECT id FROM audit_event WHERE operation = 'backup' ORDER BY id DESC LIMIT ?))`)
    .bind(WRITE_AUDIT_LIMIT, BACKUP_AUDIT_LIMIT);
}
