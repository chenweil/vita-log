import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { D1DatabaseLike, D1Statement } from '../../functions/_lib/d1-store';

/**
 * A D1 test double that runs the real SQL against real SQLite.
 *
 * The hand-rolled version of this fake was dangerous: it applied the UPDATE in
 * JavaScript, including an increment that the production statement does not
 * perform. The whole file then passed while the shipped query could never
 * advance a version and could therefore never report a conflict.
 *
 * Executing the actual statement text removes the entire failure mode. A query
 * that is wrong here is wrong in D1, because it is the same string.
 *
 * It applies `functions/schema.sql` itself for the same reason. An inlined copy
 * of the DDL would be a second source of truth that nothing checks: the write
 * tests would keep running against whatever the copy said while the deployment
 * ran the file. Reading the file is what makes "the deployed DDL is covered by
 * every test" true rather than merely intended.
 */
const DEPLOYED_SCHEMA = readFileSync(fileURLToPath(new URL('../../functions/schema.sql', import.meta.url)), 'utf8')
  // Strip line comments. This has to happen before the caller splits on `;`,
  // and it happens here so no caller has to remember: the header prose contains
  // semicolons that would otherwise cut a comment in half.
  .replace(/--[^\n]*/g, '');

export class SqliteD1 implements D1DatabaseLike {
  readonly db: DatabaseSync;
  queries: string[] = [];

  constructor(
    private readonly behaviour?: { error: Error } | { silentWrites: true },
    schema: string = DEPLOYED_SCHEMA,
  ) {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(schema);
  }

  /** Current stored version, read back through SQL rather than a JS field. */
  storedVersion(): number {
    const row = this.db.prepare('SELECT version FROM health_state WHERE id = 1').get() as { version?: number } | undefined;
    return row ? Number(row.version) : 0;
  }

  storedName(): string {
    const row = this.db.prepare('SELECT payload FROM health_state WHERE id = 1').get() as { payload?: string } | undefined;
    if (!row?.payload) throw new Error('no health_state row');
    return (JSON.parse(row.payload) as { settings: { name: string } }).settings.name;
  }

  sessionRows(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM owner_session').get() as { count?: number };
    return Number(row?.count ?? 0);
  }

  /** Every stored session key, so a test can assert the raw token is absent. */
  sessionKeys(): string[] {
    return (this.db.prepare('SELECT token_hash FROM owner_session').all() as Array<{ token_hash: string }>).map((r) => r.token_hash);
  }

  /** Seed the versioned row the way an import would have. */
  seed(payload: string, version: number, savedAt = '2026-10-05T08:00:00.000Z'): void {
    this.db.prepare('INSERT OR REPLACE INTO health_state (id, payload, version, saved_at) VALUES (1, ?, ?, ?)').run(payload, version, savedAt);
  }

  close(): void { this.db.close(); }

  prepare(query: string): D1Statement {
    this.queries.push(query);
    const db = this.db;
    const behaviour = this.behaviour;
    const placeholders = (query.match(/\?/g) ?? []).length;
    let bound: unknown[] = [];

    const first = async <T = Record<string, unknown>>(): Promise<T | null> => {
      if (behaviour && 'error' in behaviour) throw behaviour.error;
      return (db.prepare(query).get(...(bound as never[])) as T | undefined) ?? null;
    };
    const run = async (): Promise<{ meta: { changes?: number } }> => {
      if (behaviour && 'error' in behaviour) throw behaviour.error;
      // Only the versioned save goes unreported. Silencing every statement
      // would also swallow the session insert, and the request would then be
      // refused as unauthenticated — passing for the wrong reason.
      if (behaviour && 'silentWrites' in behaviour && /UPDATE health_state/.test(query)) return { meta: {} };
      // node:sqlite reports the same change count D1 puts in `meta`.
      return { meta: { changes: Number(db.prepare(query).run(...(bound as never[])).changes) } };
    };
    const statement = (values: unknown[]): D1Statement => ({
      bind: (...next: unknown[]): D1Statement => {
        const combined = [...values, ...next];
        // Real D1 rejects a statement bound with more or fewer values than it
        // has placeholders, so the double counts them and fails the same way.
        if (combined.length !== placeholders) throw new Error(`expected ${placeholders} bindings, got ${combined.length}`);
        bound = combined;
        return statement(combined);
      },
      first,
      run,
    });
    return statement(bound);
  }
}

