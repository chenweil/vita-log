import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { SqliteD1 } from './support/sqlite-d1';
import { readAudit } from '../functions/_lib/audit';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sql = (name: string): string => readFileSync(resolve(root, name), 'utf8');

it('结果语义迁移保留既有记录和游标顺序，并接受新的审计结果', async () => {
  const db = new SqliteD1(undefined, sql('functions/schema.sql') + sql('functions/migrations/0001_backup_audit.sql'));
  try {
    db.db.prepare("INSERT INTO audit_event(id,time,operation,result,version) VALUES(7,'2026-10-08T00:00:00Z','save','success',2)").run();
    db.db.prepare("INSERT INTO audit_event(id,time,operation,result,version) VALUES(8,'2026-10-08T00:00:00Z','restore','database-unavailable',0)").run();
    db.db.exec(sql('functions/migrations/0002_audit_results.sql'));
    const legacy = await readAudit(db);
    expect(legacy.events.map((event) => event.result)).toEqual(['database-unavailable', 'success']);
    expect((await readAudit(db, 8)).events.map((event) => event.version)).toEqual([2]);
    db.db.prepare("INSERT INTO audit_event(time,operation,result,version) VALUES('2026-10-08T00:00:00Z','save','unknown',2)").run();
    db.db.prepare("INSERT INTO audit_event(time,operation,result,version) VALUES('2026-10-08T00:00:00Z','restore','not-initialized',0)").run();
    expect((await readAudit(db)).events.map((event) => event.result)).toEqual(['not-initialized', 'unknown', 'database-unavailable', 'success']);
  } finally { db.close(); }
});
