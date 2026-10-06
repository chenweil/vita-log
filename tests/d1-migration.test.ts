import { describe, expect, it, beforeEach } from 'vitest';
import { createEmptySnapshot, type HealthSnapshot } from '../src/domain';
import { onRequest as onMigrateRequest } from '../functions/api/migrate';
import { onRequest as onPreviewRequest } from '../functions/api/migration-preview';
import { onRequest as onSnapshotRequest } from '../functions/api/snapshot';
import { onRequest as onSessionRequest } from '../functions/api/session';
import { createOwnerCredential, type OwnerEnv } from '../functions/_lib/owner-credentials';
import { clearRateLimits, reset, sessionKey, WRITE_ATTEMPTS as WRITE_LIMIT } from '../functions/_lib/rate-limit';
import { commitHealthState, type D1DatabaseLike } from '../functions/_lib/d1-store';
import { commitMigration, isD1Empty, MigrationConflictError, summarizeMigration } from '../functions/_lib/migration';
import { SqliteD1 } from './support/sqlite-d1';

const OWNER = 'owner';
const PASSWORD = 'a sufficiently long owner password';
const ORIGIN = 'https://vita-log.pages.dev';
const HOST = 'vita-log.pages.dev';
/** A fixed client address, so the per-address budget is the one under test. */
const ADDRESS = '203.0.113.9';

const CREDENTIAL = await createOwnerCredential(PASSWORD);
const ownerEnv = (overrides: Partial<OwnerEnv> & { VITA_LOG_DB?: D1DatabaseLike } = {}): OwnerEnv & { VITA_LOG_DB?: D1DatabaseLike } => ({
  VITA_LOG_OWNER_USERNAME: OWNER,
  VITA_LOG_OWNER_CREDENTIAL: CREDENTIAL,
  ...overrides,
});

const now = (): number => Date.parse('2026-10-06T09:30:00.000Z');

/** A snapshot with one of every record type and a recognizable name. */
function sampleSnapshot(): HealthSnapshot {
  const snapshot = createEmptySnapshot('2026-10-01T00:00:00.000Z');
  snapshot.settings.name = '陈威龙';
  snapshot.settings.heightCm = 170;
  snapshot.settings.targetWeightKg = 65;
  snapshot.settings.calorieTarget = 1800;
  snapshot.weights = [
    { id: 'w1', date: '2026-09-01', weightKg: 78.3, note: '', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
    { id: 'w2', date: '2026-09-20', weightKg: 74.1, note: '', createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z' },
  ];
  snapshot.measurements = [
    { id: 'm1', date: '2026-09-15', waistCm: 88, hipCm: 98, note: '', createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z' },
  ];
  snapshot.steps = [
    { id: 's1', date: '2026-09-18', steps: 12000, note: '', createdAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z' },
  ];
  snapshot.checkins = [
    { id: 'c1', date: '2026-09-19', type: 'train', item: '力量 · 推类', done: true, note: '', createdAt: '2026-09-19T00:00:00.000Z', updatedAt: '2026-09-19T00:00:00.000Z' },
  ];
  snapshot.diets = [
    { id: 'd1', date: '2026-09-21', meal: '早餐', food: '燕麦', calorie: 400, protein: 20, fat: 10, carb: 50, sodium: 300, note: '', createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z' },
    { id: 'd2', date: '2026-09-22', meal: '午餐', food: '鸡胸', calorie: 600, protein: 45, fat: 15, carb: 55, sodium: 700, note: '', createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z' },
  ];
  return snapshot;
}

const login = async (db: D1DatabaseLike | undefined): Promise<string> => {
  const response = await onSessionRequest({
    request: new Request(`${ORIGIN}/api/session`, {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json', origin: ORIGIN, host: HOST }),
      body: JSON.stringify({ username: OWNER, password: PASSWORD }),
    }),
    env: ownerEnv({ VITA_LOG_DB: db }),
  });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie') ?? '';
};

/**
 * Rewrite the stored payload immediately after the migration INSERT lands.
 *
 * A `prepare` wrapper rather than a change to production code, because the thing
 * under test is the reconciliation that runs *after* the write: corrupting the
 * row inside `commitMigration` would test a code path that does not exist.
 */
const corruptAfterInsert = (db: SqliteD1, replacement: () => string): void => {
  const realPrepare = db.prepare.bind(db);
  db.prepare = (query: string) => {
    const statement = realPrepare(query);
    return {
      bind: (...values: unknown[]) => {
        const bound = statement.bind(...values);
        return {
          ...bound,
          run: async () => {
            const result = await bound.run();
            if (/INSERT INTO health_state/.test(query)) {
              db.db.prepare('UPDATE health_state SET payload = ? WHERE id = 1').run(replacement());
            }
            return result;
          },
        } as never;
      },
      first: statement.first,
      run: statement.run,
    };
  };
};

const post = (
  route: 'migrate' | 'migration-preview',
  db: D1DatabaseLike | undefined,
  body: unknown,
  cookie = '',
  extraHeaders: Record<string, string> = {},
) => {
  const handler = route === 'migrate' ? onMigrateRequest : onPreviewRequest;
  const headers = new Headers({ 'content-type': 'application/json', origin: ORIGIN, host: HOST, ...extraHeaders });
  if (cookie) headers.set('cookie', cookie);
  return handler({
    request: new Request(`${ORIGIN}/api/${route}`, { method: 'POST', headers, body: JSON.stringify(body) }),
    env: ownerEnv({ VITA_LOG_DB: db }),
  });
};

const migrate = (db: D1DatabaseLike | undefined, snapshot: HealthSnapshot, cookie: string, expectedVersion = 0) =>
  post('migrate', db, { snapshot, expectedVersion }, cookie);

/**
 * A D1 that already holds a snapshot.
 *
 * Seeded directly rather than through `commitHealthState`, because the daily
 * save deliberately refuses to create this row — that refusal is the property
 * that keeps a stray save from replacing a migration. Seeding here is the only
 * way to construct the "D1 is not empty" case at all, which is itself the point.
 */
const seededD1 = (snapshot: HealthSnapshot = createEmptySnapshot('2026-08-01T00:00:00.000Z'), version = 1): SqliteD1 => {
  const db = new SqliteD1();
  db.seed(JSON.stringify(snapshot), version, '2026-08-01T00:00:00.000Z');
  return db;
};

const preview = (db: D1DatabaseLike | undefined, snapshot: HealthSnapshot, cookie: string, source?: string) =>
  post('migration-preview', db, source === undefined ? { snapshot } : { snapshot, source }, cookie);

beforeEach(() => { clearRateLimits(); });

describe('D1 首次迁移', () => {
  it('空库时导入完整快照，并留下版本 1 与时间戳', async () => {
    const db = new SqliteD1();
    const cookie = await login(db);
    const snapshot = sampleSnapshot();

    const response = await migrate(db, snapshot, cookie);
    expect(response.status).toBe(200);
    const body = await response.json() as { version: number; savedAt: string; summary: unknown };

    expect(body.version).toBe(1);
    // The route stamps the real clock, so this asserts the shape and, below,
    // that the payload and the row agree — not a fixed instant.
    expect(body.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(db.storedVersion()).toBe(1);

    // Every record type arrived, not just a shape that validates.
    const stored = JSON.parse(db.db.prepare('SELECT payload FROM health_state WHERE id=1').get()!.payload as string) as HealthSnapshot;
    expect(stored.weights).toHaveLength(2);
    expect(stored.measurements).toHaveLength(1);
    expect(stored.steps).toHaveLength(1);
    expect(stored.checkins).toHaveLength(1);
    expect(stored.diets).toHaveLength(2);
    expect(stored.settings.name).toBe('陈威龙');
    // The payload's own updatedAt and the row's saved_at come from one clock.
    expect(stored.updatedAt).toBe(body.savedAt);
    db.close();
  });

  it('D1 非空时拒绝迁移，且原有快照一个字节都不变', async () => {
    // An online source of truth that is NOT the local snapshot.
    const existing = createEmptySnapshot('2026-08-01T00:00:00.000Z');
    existing.settings.name = '线上已有数据';
    const db = seededD1(existing);
    const cookie = await login(db);
    const before = db.db.prepare('SELECT payload, version, saved_at FROM health_state WHERE id=1').get();

    const response = await migrate(db, sampleSnapshot(), cookie);
    expect(response.status).toBe(409);
    const body = await response.json() as { code: string };
    expect(body.code).toBe('migration-conflict');

    const after = db.db.prepare('SELECT payload, version, saved_at FROM health_state WHERE id=1').get();
    expect(after).toEqual(before);
    expect(JSON.parse((after as { payload: string }).payload).settings.name).toBe('线上已有数据');
    db.close();
  });

  it('重复迁移被同一个空库保护拒绝，版本不推进', async () => {
    const db = new SqliteD1();
    const cookie = await login(db);
    const snapshot = sampleSnapshot();

    expect((await migrate(db, snapshot, cookie)).status).toBe(200);
    const afterFirst = db.db.prepare('SELECT payload, version FROM health_state WHERE id=1').get();

    // The same import again, and a different one: both are refused.
    expect((await migrate(db, snapshot, cookie)).status).toBe(409);
    const other = sampleSnapshot();
    other.settings.name = '第二次迁移';
    expect((await migrate(db, other, cookie)).status).toBe(409);

    const afterSecond = db.db.prepare('SELECT payload, version FROM health_state WHERE id=1').get();
    expect(afterSecond).toEqual(afterFirst);
    db.close();
  });

  it('空库保护在同一条语句里，不是先查后写', async () => {
    // A check-then-insert would leave a window in which a concurrent import
    // lands and both callers report success. The guard has to be part of the
    // INSERT, so this asserts on the statement text itself rather than on
    // timing, which a sequential test could not pin down anyway.
    const db = new SqliteD1();
    const cookie = await login(db);
    await migrate(db, sampleSnapshot(), cookie);

    const inserts = db.queries.filter((q) => /INSERT INTO health_state/.test(q));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatch(/WHERE NOT EXISTS/i);
    db.close();
  });

  it('迁移写入的是规范化后的快照，而不是调用方原样传来的 JSON', async () => {
    // The migration and the daily save share one payload builder. If the import
    // wrote the caller's raw JSON instead, a payload carrying extra or renamed
    // fields would land in D1 and the public read path — which normalizes on the
    // way out — would silently serve something the owner never approved.
    const db = new SqliteD1();
    const cookie = await login(db);
    const raw = { ...sampleSnapshot(), nickname: '不该出现的字段' } as unknown as HealthSnapshot;

    expect((await migrate(db, raw, cookie)).status).toBe(200);
    const stored = JSON.parse(db.db.prepare('SELECT payload FROM health_state WHERE id=1').get()!.payload as string) as Record<string, unknown>;
    expect(stored.nickname).toBeUndefined();
    expect(stored.app).toBe('vita-log');
    expect(stored.schemaVersion).toBe(1);
    db.close();
  });

  it('迁移后日常保存照常推进版本，不被导入的版本 1 卡住', async () => {
    const db = new SqliteD1();
    const cookie = await login(db);
    const snapshot = sampleSnapshot();
    await migrate(db, snapshot, cookie);

    // The version the migration stamped is the version the next save expects.
    const saved = await commitHealthState(db, snapshot, 1, Date.parse('2026-10-07T00:00:00.000Z'));
    expect(saved.version).toBe(2);
    expect(db.storedVersion()).toBe(2);
    db.close();
  });
});

describe('迁移预览', () => {
  it('展示来源、数量、总数、日期范围、营养汇总和设置摘要', async () => {
    const db = new SqliteD1();
    const cookie = await login(db);

    const response = await preview(db, sampleSnapshot(), cookie, '本机 SQLite');
    expect(response.status).toBe(200);
    const body = await response.json() as {
      source: string; empty: boolean;
      summary: {
        counts: Record<string, number>; total: number; firstDate: string | null; lastDate: string | null;
        nutrition: { calorie: number; protein: number; fat: number; carb: number; sodium: number };
        settings: { name: string; heightCm: number; targetWeightKg: number; calorieTarget: number };
      };
    };

    expect(body.source).toBe('本机 SQLite');
    expect(body.empty).toBe(true);
    expect(body.summary.counts).toEqual({ weights: 2, measurements: 1, steps: 1, checkins: 1, diets: 2 });
    expect(body.summary.total).toBe(7);
    expect(body.summary.firstDate).toBe('2026-09-01');
    expect(body.summary.lastDate).toBe('2026-09-22');
    expect(body.summary.nutrition).toEqual({ calorie: 1000, protein: 65, fat: 25, carb: 105, sodium: 1000 });
    expect(body.summary.settings).toEqual({ name: '陈威龙', heightCm: 170, targetWeightKg: 65, calorieTarget: 1800 });
    db.close();
  });

  it('D1 非空时预览如实报告，但导入会被拒绝', async () => {
    const db = seededD1();
    const cookie = await login(db);

    const response = await preview(db, sampleSnapshot(), cookie);
    expect(response.status).toBe(200);
    expect((await response.json() as { empty: boolean }).empty).toBe(false);
    // Reporting the conflict here is not the same as enforcing it there.
    expect((await migrate(db, sampleSnapshot(), cookie)).status).toBe(409);
    db.close();
  });

  it('预览不写 D1：反复调用后仍然是空库', async () => {
    const db = new SqliteD1();
    const cookie = await login(db);

    expect((await preview(db, sampleSnapshot(), cookie)).status).toBe(200);
    expect((await preview(db, sampleSnapshot(), cookie)).status).toBe(200);
    expect(await isD1Empty(db)).toBe(true);
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM health_state').get()).toEqual({ count: 0 });
    db.close();
  });

  it('预览拒绝的，正是导入会拒绝的：两者不会对同一份数据给出不同答复', async () => {
    // The dangerous shape is a payload that is *traversable* but semantically
    // wrong — `name: 12345`, `date: 'not-a-date'`. Summing it does not throw, so
    // an unvalidated preview happily reports counts for data the import would
    // reject: the owner approves a preview that can never succeed, and the
    // numbers they were shown describe nothing D1 will hold.
    const traversable = {
      app: 'vita-log',
      schemaVersion: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      settings: { name: 12345, heightCm: 'tall', targetWeightKg: null, calorieTarget: 'lots' },
      weights: [{ id: 'w', date: 'not-a-date', weightKg: -5 }],
      measurements: [], steps: [], checkins: [], diets: [],
    } as unknown as HealthSnapshot;

    const db = new SqliteD1();
    const cookie = await login(db);
    const previewed = await preview(db, traversable, cookie);
    const imported = await migrate(db, traversable, cookie);

    expect(previewed.status, '预览接受了导入必定拒绝的快照').toBe(400);
    expect(imported.status).toBe(400);
    expect((await previewed.json() as { code: string }).code).toBe('validation-failed');
    expect(await isD1Empty(db)).toBe(true);
    db.close();
  });

  it('快照无法通过校验时预览拒绝，而不是返回一份空摘要', async () => {
    const db = new SqliteD1();
    const cookie = await login(db);

    const response = await post('migration-preview', db, { snapshot: { app: 'vita-log', schemaVersion: 1, settings: {} } }, cookie);
    expect(response.status).toBe(400);
    expect((await response.json() as { code: string }).code).toBe('validation-failed');
    expect(await isD1Empty(db)).toBe(true);
    db.close();
  });
});

describe('确认与原子性', () => {
  it('迁移需要本人会话：匿名、伪造和过期会话都不能写入', async () => {
    for (const cookie of ['', 'vita-log-session=' + 'f'.repeat(64)]) {
      const db = new SqliteD1();
      const response = await migrate(db, sampleSnapshot(), cookie);
      expect([401, 403]).toContain(response.status);
      expect(await isD1Empty(db)).toBe(true);
      db.close();
    }
  });

  it('跨站迁移请求被拒绝，且不触碰 D1', async () => {
    const db = new SqliteD1();
    const cookie = await login(db);
    const response = await post('migrate', db, { snapshot: sampleSnapshot(), expectedVersion: 0 }, cookie, { origin: 'https://evil.example' });
    expect(response.status).toBe(403);
    expect(await isD1Empty(db)).toBe(true);
    db.close();
  });

  it('迁移只接受 POST，预览也只接受 POST', async () => {
    const db = new SqliteD1();
    const cookie = await login(db);
    for (const route of ['migrate', 'migration-preview'] as const) {
      const handler = route === 'migrate' ? onMigrateRequest : onPreviewRequest;
      const get = await handler({
        request: new Request(`${ORIGIN}/api/${route}`, { method: 'GET', headers: new Headers({ origin: ORIGIN, host: HOST, cookie }) }),
        env: ownerEnv({ VITA_LOG_DB: db }),
      });
      expect(get.status, `${route} 的 GET 应当被拒绝`).toBe(405);
    }
    expect(await isD1Empty(db)).toBe(true);
    db.close();
  });

  it('迁移请求过于频繁时被限流，且不写入 D1', async () => {
    const db = new SqliteD1();
    const cookie = await login(db);
    // A migration is the most destructive write this app has, so it spends the
    // same budget a daily save does rather than a separate, larger one.
    let last = 0;
    for (let attempt = 0; attempt <= WRITE_LIMIT; attempt += 1) {
      last = (await migrate(db, sampleSnapshot(), cookie)).status;
    }
    expect(last, '超过写入预算后应当被限流').toBe(429);
    // The refused attempt wrote nothing, and the ones before it left one row.
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM health_state').get()).toEqual({ count: 1 });
    db.close();
  });

  it('会话与地址两个限流维度各自生效', async () => {
    // Both budgets are the same size and an un-attributed request reports the
    // same address every time, so a test that only counts attempts cannot say
    // which dimension stopped it. Each is exhausted on its own here: a rotating
    // address leaves the session budget to be the one that trips, and a fixed
    // address with a cleared session bucket leaves the address one.
    const sessionBudget = async (): Promise<boolean> => {
      const db = new SqliteD1();
      const cookie = await login(db);
      let limited = false;
      for (let attempt = 0; attempt <= WRITE_LIMIT; attempt += 1) {
        // A fresh address each time, so the address budget cannot be the cause.
        const response = await post('migrate', db, { snapshot: sampleSnapshot(), expectedVersion: 0 }, cookie, { 'cf-connecting-ip': `10.0.0.${attempt}` });
        if (response.status === 429) limited = true;
      }
      db.close();
      return limited;
    };
    expect(await sessionBudget(), '轮换来源地址时，仍应由会话预算拦住').toBe(true);

    const addressBudget = async (): Promise<boolean> => {
      const db = new SqliteD1();
      const cookie = await login(db);
      // Clear the session bucket between attempts — keyed by the real token —
      // so the address budget is the only one that can run out.
      let limited = false;
      const token = /vita-log-session=([^;]+)/.exec(cookie)?.[1] ?? '';
      for (let attempt = 0; attempt <= WRITE_LIMIT; attempt += 1) {
        reset(sessionKey(token));
        const response = await post('migrate', db, { snapshot: sampleSnapshot(), expectedVersion: 0 }, cookie, { 'cf-connecting-ip': ADDRESS });
        if (response.status === 429) limited = true;
      }
      db.close();
      return limited;
    };
    expect(await addressBudget(), '同一地址反复写入时，地址预算必须拦住').toBe(true);
  });

  it('版本字段畸形时不按「空库」放行', async () => {
    // `Number` maps '', null and [] to 0 — the one value that passes the check —
    // so a malformed field must be refused outright rather than normalized into
    // an accidental pass. The empty-database guard is what actually protects the
    // data; this check only has to fail loudly.
    const db = new SqliteD1();
    const cookie = await login(db);
    for (const expectedVersion of ['', null, [], {}, 'abc', -1, 1.5]) {
      const response = await post('migrate', db, { snapshot: sampleSnapshot(), expectedVersion }, cookie);
      expect([400, 409], `expectedVersion=${JSON.stringify(expectedVersion)} 不应被当作空库放行`).toContain(response.status);
      expect(await isD1Empty(db)).toBe(true);
    }
    db.close();
  });

  it('基于过期预览的确认被版本检查拒绝', async () => {
    const db = new SqliteD1();
    const cookie = await login(db);
    // A confirmation that claims to follow a non-empty preview: D1 is empty, so
    // the version the owner was shown does not describe this database.
    const response = await migrate(db, sampleSnapshot(), cookie, 7);
    expect(response.status).toBe(409);
    expect((await response.json() as { code: string }).code).toBe('version-conflict');
    expect(await isD1Empty(db)).toBe(true);
    db.close();
  });

  it('写入语句本身失败时迁移失败，且不留下半行数据', async () => {
    // Only the INSERT is refused. A whole-database outage would be caught at the
    // session lookup and would never reach the migration code, so this case
    // would pass for the wrong reason if the failure were not placed here.
    const db = new SqliteD1({ failOn: /INSERT INTO health_state/ });
    const cookie = await login(db);
    expect(db.sessionRows()).toBe(1);

    const response = await migrate(db, sampleSnapshot(), cookie);
    expect(response.status).toBe(503);
    expect((await response.json() as { code: string }).code).toBe('database-unavailable');
    // No partial row: the guard and the insert were one statement, and it failed.
    expect(await isD1Empty(db)).toBe(true);
    db.close();
  });

  it('对账失败发生在写入之后：错误信息不说 D1 未被改动', async () => {
    // The honesty check. Every pre-INSERT refusal leaves D1 untouched, but a
    // reconciliation failure happens after the row is stored — saying "未改动"
    // there would send the owner looking for a database state that does not
    // exist. What matters instead is that the next attempt refuses to overwrite.
    const db = new SqliteD1();
    const cookie = await login(db);
    corruptAfterInsert(db, () => JSON.stringify(createEmptySnapshot()));

    const response = await migrate(db, sampleSnapshot(), cookie);
    expect(response.status).toBe(503);
    const message = (await response.json() as { message: string }).message;
    expect(message).not.toContain('未改动');
    expect(message).not.toContain('未改变');
    expect(message).toContain('对账');

    // The row really is there, and the empty-database guard now refuses a retry.
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM health_state').get()).toEqual({ count: 1 });
    expect((await migrate(db, sampleSnapshot(), cookie)).status).toBe(409);
    db.close();
  });

  it('写入之前的每一次拒绝都让 D1 原封不动', async () => {
    // The cases that must not touch D1 at all: bad payload, non-empty database,
    // stale preview, unreachable write. Each is checked by row content, not just
    // by status code.
    const invalid = { app: 'vita-log', schemaVersion: 1, settings: {} };

    const db1 = new SqliteD1();
    const bad = await post('migrate', db1, { snapshot: invalid, expectedVersion: 0 }, await login(db1));
    expect(bad.status).toBe(400);
    expect(await isD1Empty(db1)).toBe(true);

    const db2 = seededD1();
    const busy = await migrate(db2, sampleSnapshot(), await login(db2), 0);
    expect(busy.status).toBe(409);
    expect(db2.db.prepare('SELECT COUNT(*) AS count FROM health_state').get()).toEqual({ count: 1 });

    const db3 = new SqliteD1();
    const stale = await migrate(db3, sampleSnapshot(), await login(db3), 5);
    expect(stale.status).toBe(409);
    expect(await isD1Empty(db3)).toBe(true);

    const db4 = new SqliteD1({ failOn: /INSERT INTO health_state/ });
    const broken = await migrate(db4, sampleSnapshot(), await login(db4));
    expect(broken.status).toBe(503);
    expect(await isD1Empty(db4)).toBe(true);

    for (const db of [db1, db2, db3, db4]) db.close();
  });

  it('版本或时间戳与导入时不一致时，对账拒绝', async () => {
    // The payload can be intact and the row still be wrong: a version or a clock
    // that disagrees with this import leaves the very next daily save starting
    // from a version the owner never saw.
    for (const column of ['version', 'saved_at'] as const) {
      const db = new SqliteD1();
      const cookie = await login(db);
      const realPrepare = db.prepare.bind(db);
      db.prepare = (query: string) => {
        const statement = realPrepare(query);
        return {
          bind: (...values: unknown[]) => {
            const bound = statement.bind(...values);
            return {
              ...bound,
              run: async () => {
                const result = await bound.run();
                if (/INSERT INTO health_state/.test(query)) {
                  const value = column === 'version' ? 99 : '2001-01-01T00:00:00.000Z';
                  db.db.prepare(`UPDATE health_state SET ${column} = ? WHERE id = 1`).run(value);
                }
                return result;
              },
            } as never;
          },
          first: statement.first,
          run: statement.run,
        };
      };

      const response = await migrate(db, sampleSnapshot(), cookie);
      expect(response.status, `${column} 不一致时应当拒绝迁移`).toBe(503);
      expect((await response.json() as { message: string }).message).toContain('对账');
      db.close();
    }
  });

  it('D1 不返回写入结果时迁移不报成功', async () => {
    // D1 reporting no change count is not a successful import. Silencing only
    // the migration INSERT keeps the session lookup working, so this reaches the
    // migration code instead of being refused at the door as unauthenticated.
    const db = new SqliteD1({ silentInsert: true });
    const cookie = await login(db);
    const response = await migrate(db, sampleSnapshot(), cookie);
    expect(response.status).toBe(503);
    expect((await response.json() as { message: string }).message).toContain('未返回迁移结果');
    db.close();
  });

  it('整个 D1 不可达时迁移报 503，而不是伪装成会话失效', async () => {
    const db = new SqliteD1({ error: new Error('D1 完全不可达') });
    const response = await migrate(db, sampleSnapshot(), 'vita-log-session=' + 'a'.repeat(64));
    expect(response.status).toBe(503);
    expect((await response.json() as { code: string }).code).toBe('database-unavailable');
    db.close();
  });

  it('对账不通过时迁移不报成功', async () => {
    // The row lands and is then corrupted before the read-back, which is what a
    // truncated or rewritten write looks like from here. The import must refuse
    // rather than hand the owner a success it cannot back up.
    const db = new SqliteD1();
    const cookie = await login(db);
    corruptAfterInsert(db, () => JSON.stringify(createEmptySnapshot()));

    const response = await migrate(db, sampleSnapshot(), cookie);
    expect(response.status).toBe(503);
    const body = await response.json() as { code: string; message: string };
    expect(body.code).toBe('database-unavailable');
    expect(body.message).toContain('对账');
    db.close();
  });

  it('记录内容被改但数量不变时，对账仍然拒绝', async () => {
    // The stronger case. Counts, dates, nutrition and settings all still match
    // what the owner approved, so a summary-only reconciliation would report a
    // clean import while a note — real data the owner keeps — was altered. This
    // is what pins the byte-for-byte payload comparison.
    const db = new SqliteD1();
    const cookie = await login(db);
    corruptAfterInsert(db, () => {
      const stored = JSON.parse(db.db.prepare('SELECT payload FROM health_state WHERE id=1').get()!.payload as string) as HealthSnapshot;
      stored.diets[0]!.note = '被改写的备注';
      return JSON.stringify(stored);
    });

    const response = await migrate(db, sampleSnapshot(), cookie);
    expect(response.status).toBe(503);
    expect((await response.json() as { message: string }).message).toContain('对账');
    db.close();
  });

  it('预览与导入走同一个摘要函数，预览看到的数量就是导入后的数量', async () => {
    const db = new SqliteD1();
    const cookie = await login(db);
    const snapshot = sampleSnapshot();

    const previewed = await (await preview(db, snapshot, cookie)).json() as { summary: unknown };
    const imported = await (await migrate(db, snapshot, cookie)).json() as { summary: unknown };
    expect(imported.summary).toEqual(previewed.summary);
    db.close();
  });
});

describe('迁移后的公网读取', () => {
  it('导入成功后匿名读取的就是导入的快照', async () => {
    const db = new SqliteD1();
    const cookie = await login(db);
    const snapshot = sampleSnapshot();
    expect((await migrate(db, snapshot, cookie)).status).toBe(200);

    const read = await onSnapshotRequest({
      request: new Request(`${ORIGIN}/api/snapshot`, { method: 'GET' }),
      env: ownerEnv({ VITA_LOG_DB: db }),
    });
    expect(read.status).toBe(200);
    const body = await read.json() as { settings: { name: string }; weights: unknown[]; diets: unknown[] };
    expect(body.settings.name).toBe('陈威龙');
    expect(body.weights).toHaveLength(2);
    expect(body.diets).toHaveLength(2);
    db.close();
  });

  it('未导入时匿名读取仍然 fail-closed，不返回空数据', async () => {
    const db = new SqliteD1();
    const read = await onSnapshotRequest({
      request: new Request(`${ORIGIN}/api/snapshot`, { method: 'GET' }),
      env: ownerEnv({ VITA_LOG_DB: db }),
    });
    expect(read.status).toBe(503);
    expect((await read.json() as { code: string }).code).toBe('database-unavailable');
    db.close();
  });
});

describe('迁移模块自身的边界', () => {
  it('模块层面：非空 D1 直接抛 MigrationConflictError，不改任何数据', async () => {
    const existing = createEmptySnapshot('2026-08-01T00:00:00.000Z');
    existing.settings.name = '线上已有数据';
    const db = seededD1(existing);
    const before = db.db.prepare('SELECT payload, version, saved_at FROM health_state WHERE id=1').get();

    await expect(commitMigration(db, sampleSnapshot(), 0, now())).rejects.toBeInstanceOf(MigrationConflictError);
    expect(db.db.prepare('SELECT payload, version, saved_at FROM health_state WHERE id=1').get()).toEqual(before);
    db.close();
  });

  it('摘要由服务端按记录数出来，不采信调用方给的数字', async () => {
    // The preview is what the owner approves, so its counts have to come from the
    // snapshot the import will actually write. A summary that echoed a
    // caller-supplied count would let a mismatched pair look identical.
    const snapshot = sampleSnapshot();
    const summary = summarizeMigration(snapshot);
    expect(summary.total).toBe(Object.values(summary.counts).reduce((a, b) => a + b, 0));
    expect(summary.counts.diets).toBe(snapshot.diets.length);
    expect(summarizeMigration(createEmptySnapshot()).total).toBe(0);
  });

  it('空库判断数的是表里的行，而不是 id=1 那一条', async () => {
    // The schema pins id to 1, so a second row cannot exist and a count-based
    // guard cannot be told apart from an id=1 lookup at runtime. The statement is
    // what pins the intent, and it has to be matched as a whole: `COUNT(*)`
    // followed by a `WHERE id = 1` would satisfy a looser pattern while meaning
    // the opposite of what this function promises.
    const db = seededD1();
    expect(await isD1Empty(db)).toBe(false);
    expect(db.queries).toContain('SELECT COUNT(*) AS count FROM health_state');
    expect(db.queries.some((q) => /COUNT\(\*\)[\s\S]*WHERE\s+id\s*=/.test(q))).toBe(false);
    db.close();
  });

  it('未绑定 D1 时预览和迁移都报错，不当作空库', async () => {
    await expect(isD1Empty(undefined)).rejects.toThrow();
    const { commitMigration } = await import('../functions/_lib/migration');
    await expect(commitMigration(undefined, sampleSnapshot(), 0, now())).rejects.toThrow();
  });
});