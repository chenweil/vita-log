import { describe, expect, it } from 'vitest';
import { createEmptySnapshot, type HealthSnapshot } from '../src/domain';
import { onRequest, onRequestGet } from '../functions/api/snapshot';
import type { D1DatabaseLike, D1Statement } from '../functions/_lib/d1-store';

const ownerSnapshot = (): HealthSnapshot => {
  const snapshot = createEmptySnapshot('2026-10-05T08:00:00.000Z');
  snapshot.settings.name = '轻盈';
  snapshot.weights = [{ id: 'w1', date: '2026-10-01', weightKg: 76.4, bodyfatPercent: 21.5, note: '晨起空腹', createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-01T08:00:00.000Z' }];
  snapshot.diets = [{ id: 'd1', date: '2026-10-01', meal: '午餐', food: '鸡胸沙拉', calorie: 520, protein: 42, fat: 12, carb: 48, sodium: 640, note: '自备午餐', createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-01T08:00:00.000Z' }];
  return snapshot;
};

/** A D1 whose only query returns a fixed row, or throws, to model each failure mode. */
class FakeD1 implements D1DatabaseLike {
  queries: string[] = [];
  constructor(private readonly behaviour: { row: unknown } | { error: Error } | { noRow: true }) {}
  prepare(query: string): D1Statement {
    this.queries.push(query);
    if (!query.includes('health_state')) throw new Error(`unexpected query: ${query}`);
    return this.statement(query);
  }
  private statement(query: string): D1Statement {
    const behaviour = this.behaviour;
    return {
      bind: (...values: unknown[]): D1Statement => {
        // Real D1 rejects a statement bound with more values than it has
        // placeholders, so the fake counts them and fails the same way.
        const placeholders = (query.match(/\?/g) ?? []).length;
        if (values.length !== placeholders) throw new Error(`expected ${placeholders} bindings, got ${values.length}`);
        return this.statement(query);
      },
      first: async <T = Record<string, unknown>>(): Promise<T | null> => {
        if ('error' in behaviour) throw behaviour.error;
        if ('noRow' in behaviour) return null;
        return behaviour.row as T;
      },
    };
  }
}

const row = (snapshot: HealthSnapshot, version = 7): unknown => ({
  payload: JSON.stringify(snapshot), version, saved_at: snapshot.updatedAt,
});

const call = (db: D1DatabaseLike | undefined, url = 'https://vita-log.pages.dev/api/snapshot'): Promise<Response> =>
  onRequestGet({ request: new Request(url), env: db ? { VITA_LOG_DB: db } : {} });

describe('Pages Function 公开读取契约', () => {
  it('未登录访客可读取完整看板，无需任何凭据', async () => {
    const response = await call(new FakeD1({ row: row(ownerSnapshot()) }));
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.app).toBe('vita-log-public');
    expect((body.settings as Record<string, unknown>).name).toBe('轻盈');
    expect((body.weights as unknown[])).toHaveLength(1);
    expect((body.diets as unknown[])).toHaveLength(1);
  });

  it('响应使用 Cache-Control: no-store', async () => {
    const ok = await call(new FakeD1({ row: row(ownerSnapshot()) }));
    expect(ok.headers.get('cache-control')).toBe('no-store');
    const failed = await call(new FakeD1({ error: new Error('D1 down') }));
    expect(failed.headers.get('cache-control')).toBe('no-store');
  });

  it('公开响应不含密码摘要、会话、备份或内部存储元数据', async () => {
    const response = await call(new FakeD1({ row: row(ownerSnapshot()) }));
    // Field-level, so the check cannot pass or fail on a substring coincidence.
    const body = await response.text();
    const parsed = JSON.parse(body) as { settings: Record<string, unknown> };
    expect(Object.keys(parsed).sort()).toEqual(
      ['app', 'checkins', 'diets', 'measurements', 'publicSchemaVersion', 'settings', 'sourceSchemaVersion', 'steps', 'updatedAt', 'weights'],
    );
    expect(Object.keys(parsed.settings).sort()).toEqual([
      'activityFactor', 'age', 'calorieTarget', 'carbTarget', 'fatTarget', 'gender', 'habits',
      'heightCm', 'name', 'proteinTarget', 'sodiumTarget', 'startWeightKg', 'targetBodyfatPercent',
      'targetWeightKg', 'trainingPlan',
    ]);
    for (const forbidden of ['salt', 'hash', 'session', 'token', 'backup', 'recovery', 'saved_at', 'primaryColor', 'accentColor']) {
      expect(body, `泄露 ${forbidden}`).not.toContain(forbidden);
    }
    // The row's optimistic-concurrency column is internal storage metadata.
    expect(body).not.toContain('"version"');
  });

  it('可以处理 Cloudflare 公开域名，不假设 127.0.0.1', async () => {
    for (const host of ['https://vita-log.pages.dev', 'https://vita.example.com']) {
      const response = await call(new FakeD1({ row: row(ownerSnapshot()) }), `${host}/api/snapshot`);
      expect(response.status, host).toBe(200);
    }
  });

  it('D1 查询失败时返回稳定 database-unavailable，不返回空快照', async () => {
    const response = await call(new FakeD1({ error: new Error('D1 binding exploded') }));
    expect(response.status).toBe(503);
    const body = await response.json() as { code: string; message: string };
    expect(body.code).toBe('database-unavailable');
    expect(body).not.toHaveProperty('settings');
    expect(body).not.toHaveProperty('weights');
  });

  it('缺少 D1 绑定时同样 fail-closed', async () => {
    const response = await call(undefined);
    expect(response.status).toBe(503);
    expect((await response.json() as { code: string }).code).toBe('database-unavailable');
  });

  it('空库（尚未导入）不会被伪装成空健康数据', async () => {
    const response = await call(new FakeD1({ noRow: true }));
    expect(response.status).toBe(503);
    const body = await response.json() as { code: string; message: string };
    expect(body.code).toBe('database-unavailable');
    expect(body.message).toContain('尚未导入');
    expect(body).not.toHaveProperty('weights');
  });

  it('损坏的 D1 载荷不会被降级为空快照', async () => {
    for (const payload of ['{not json', JSON.stringify({ app: 'other', schemaVersion: 1 }), JSON.stringify({ app: 'vita-log', schemaVersion: 99 })]) {
      const response = await call(new FakeD1({ row: { payload, version: 1, saved_at: '2026-10-05T08:00:00.000Z' } }));
      expect(response.status, payload).toBe(503);
      const body = await response.json() as Record<string, unknown>;
      expect(body.code).toBe('database-unavailable');
      expect(body).not.toHaveProperty('weights');
    }
  });

  it('只读 payload；version/saved_at 属于写路径，不影响匿名读取', async () => {
    // A row carrying neither column still reads fine: the anonymous reader has
    // no use for them, so they must not be able to gate availability.
    const db = new FakeD1({ row: { payload: JSON.stringify(ownerSnapshot()) } });
    const response = await call(db);
    expect(response.status).toBe(200);
    expect((await response.json() as { settings: { name: string } }).settings.name).toBe('轻盈');
    expect(db.queries[0]).toContain('SELECT payload FROM');
  });

  it('查询用占位符绑定 id，不多绑也不少绑', async () => {
    // The fake counts placeholders and throws on a mismatch, so a query that
    // binds a value it never references fails here the way real D1 would.
    const db = new FakeD1({ row: row(ownerSnapshot()) });
    expect((await call(db)).status).toBe(200);
  });

  it('非 GET 方法被明确拒绝，且同样 no-store', async () => {
    for (const method of ['PUT', 'POST', 'DELETE', 'PATCH']) {
      const response = await onRequest({ request: new Request('https://vita-log.pages.dev/api/snapshot', { method }), env: { VITA_LOG_DB: new FakeD1({ row: row(ownerSnapshot()) }) } });
      expect(response.status, method).toBe(405);
      expect(response.headers.get('cache-control'), method).toBe('no-store');
      expect((await response.json() as { code: string }).code, method).toBe('validation-failed');
    }
  });
});
