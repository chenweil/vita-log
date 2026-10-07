import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEmptySnapshot } from '../src/domain';
import { createOwnerCredential } from '../functions/_lib/owner-credentials';
import { CloudflareRuntime, resetRuntime } from './support/cloudflare-runtime';
import { SqliteD1 } from './support/sqlite-d1';
import { onRequestPost as restoreRequest } from '../functions/api/restore';
import { recordBackup } from '../functions/_lib/audit';
import type { D1Statement } from '../functions/_lib/d1-store';

const PASSWORD = 'a sufficiently long owner password';
const credential = await createOwnerCredential(PASSWORD);
let runtime: CloudflareRuntime;
beforeEach(() => {
  resetRuntime();
  runtime = new CloudflareRuntime({ credential });
  const snapshot = createEmptySnapshot();
  snapshot.settings.name = 'backup owner';
  runtime.db.seed(JSON.stringify(snapshot), 4);
});
afterEach(() => { runtime.close(); resetRuntime(); vi.restoreAllMocks(); });

it('完整备份只向本人提供，访客被拒绝且响应不缓存', async () => {
  const anonymous = await runtime.fetch('/api/backup');
  expect(anonymous.status).toBe(401);
  expect(anonymous.headers.get('cache-control')).toBe('no-store');
  expect(await anonymous.text()).not.toContain('backup owner');
  await runtime.fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: PASSWORD }) });
  const response = await runtime.fetch('/api/backup');
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const backup = await response.json();
  expect(backup.version).toBe(4);
  expect(backup.snapshot.settings.name).toBe('backup owner');
  expect(JSON.stringify(backup)).not.toMatch(/token_hash|credential|owner_session/);
});

it('保存产生最小审计，访客不能读取审计内部字段', async () => {
  await runtime.fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: PASSWORD }) });
  const next = createEmptySnapshot();
  next.settings.name = 'private health content';
  const saved = await runtime.fetch('/api/snapshot', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshot: next, expectedVersion: 4 }) });
  expect(saved.status).toBe(200);
  const response = await runtime.fetch('/api/audit');
  expect(response.status).toBe(200);
  const { events } = await response.json();
  expect(events).toContainEqual({ time: expect.any(String), operation: 'save', result: 'success', version: 5 });
  for (const event of events) expect(Object.keys(event).sort()).toEqual(['operation', 'result', 'time', 'version']);
  expect(JSON.stringify(events)).not.toMatch(/private health content|token|password|credential/);
  runtime.clearSessionCookie();
  expect((await runtime.fetch('/api/audit')).status).toBe(401);
  const publicData = await (await runtime.fetch('/api/snapshot')).json();
  expect(publicData).not.toHaveProperty('events');
});

it('恢复需要本人会话，版本冲突时不覆盖在线数据，成功时记录恢复审计', async () => {
  const target = createEmptySnapshot();
  target.settings.name = 'restored owner';
  const request = (expectedVersion: number) => runtime.fetch('/api/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshot: target, expectedVersion }) });
  expect((await request(4)).status).toBe(401);
  await runtime.fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: PASSWORD }) });
  expect((await request(3)).status).toBe(409);
  expect((await (await runtime.fetch('/api/backup')).json()).snapshot.settings.name).toBe('backup owner');
  expect((await request(4)).status).toBe(200);
  expect((await (await runtime.fetch('/api/backup')).json()).snapshot.settings.name).toBe('restored owner');
  const { events } = await (await runtime.fetch('/api/audit')).json();
  expect(events).toContainEqual({ time: expect.any(String), operation: 'restore', result: 'success', version: 5 });
  expect(events).toContainEqual({ time: expect.any(String), operation: 'restore', result: 'version-conflict', version: 3 });
});

it('审计失败时保存回滚，备份失败不返回健康载荷', async () => {
  runtime.close();
  runtime = new CloudflareRuntime({ credential, db: new SqliteD1({ failOn: /INSERT INTO audit_event/ }) });
  const original = createEmptySnapshot();
  original.settings.name = 'original';
  runtime.db.seed(JSON.stringify(original), 4);
  await runtime.fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: PASSWORD }) });
  const response = await runtime.fetch('/api/backup');
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('original');
  const next = createEmptySnapshot();
  next.settings.name = 'replacement';
  expect((await runtime.fetch('/api/snapshot', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshot: next, expectedVersion: 4 }) })).status).toBe(503);
  const current = await (await runtime.fetch('/api/owner-snapshot')).json();
  expect(current.version).toBe(4);
  expect(current.snapshot.settings.name).toBe('original');
});

it('首次迁移也产生原子审计事件', async () => {
  runtime.db.db.exec('DELETE FROM health_state');
  await runtime.fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: PASSWORD }) });
  expect((await runtime.fetch('/api/migrate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshot: createEmptySnapshot(), expectedVersion: 0 }) })).status).toBe(200);
  const { events } = await (await runtime.fetch('/api/audit')).json();
  expect(events).toContainEqual({ time: expect.any(String), operation: 'migrate', result: 'success', version: 1 });
});

it('并发保存只有一个成功，另一个报告版本冲突', async () => {
  await runtime.fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: PASSWORD }) });
  const save = (name: string) => {
    const snapshot = createEmptySnapshot();
    snapshot.settings.name = name;
    return runtime.fetch('/api/snapshot', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshot, expectedVersion: 4 }) });
  };
  const responses = await Promise.all([save('first'), save('second')]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  const { events } = await (await runtime.fetch('/api/audit')).json();
  expect(events.filter((event: { result: string }) => event.result === 'success')).toHaveLength(1);
  expect(events.filter((event: { result: string }) => event.result === 'version-conflict')).toHaveLength(1);
});

it('直接绕过客户端的跨站恢复请求仍被拒绝', async () => {
  await runtime.fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: PASSWORD }) });
  const response = await restoreRequest({ env: runtime.env, request: new Request('https://vita-log.pages.dev/api/restore', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: runtime.sessionCookie, origin: 'https://attacker.example', host: 'vita-log.pages.dev' },
    body: JSON.stringify({ snapshot: createEmptySnapshot(), expectedVersion: 4 }),
  }) });
  expect(response.status).toBe(403);
  expect((await (await runtime.fetch('/api/backup')).json()).version).toBe(4);
});

it('数据更新失败时不留下成功审计，在线快照保持原值', async () => {
  runtime.close();
  runtime = new CloudflareRuntime({ credential, db: new SqliteD1({ failOn: /UPDATE health_state/ }) });
  const snapshot = createEmptySnapshot();
  snapshot.settings.name = 'original';
  runtime.db.seed(JSON.stringify(snapshot), 4);
  await runtime.fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: PASSWORD }) });
  snapshot.settings.name = 'replacement';
  const response = await runtime.fetch('/api/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshot, expectedVersion: 4 }) });
  expect(response.status).toBe(503);
  const { events } = await (await runtime.fetch('/api/audit')).json();
  expect(events).toEqual([]);
  expect((await (await runtime.fetch('/api/owner-snapshot')).json()).snapshot.settings.name).toBe('original');
});

it('损坏的数据库载荷返回不可用，不提供空备份', async () => {
  await runtime.fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: PASSWORD }) });
  runtime.db.seed('not json', 4);
  const response = await runtime.fetch('/api/backup');
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'database-unavailable' });
});

it('没有确认写入时不留下虚假的 success 审计', async () => {
  runtime.close();
  runtime = new CloudflareRuntime({ credential, db: new SqliteD1({ silentWrites: true }) });
  runtime.db.seed(JSON.stringify(createEmptySnapshot()), 2);
  await runtime.fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: PASSWORD }) });
  const response = await runtime.fetch('/api/snapshot', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshot: createEmptySnapshot(), expectedVersion: 2 }) });
  expect(response.status).toBe(503);
  expect((await (await runtime.fetch('/api/owner-snapshot')).json()).version).toBe(2);
  const { events } = await (await runtime.fetch('/api/audit')).json();
  expect(events).toEqual([{ time: expect.any(String), operation: 'save', result: 'unknown', version: 2 }]);
});

it('空库的写入审计记录未初始化，不冒充数据库故障', async () => {
  runtime.db.db.exec('DELETE FROM health_state');
  await runtime.fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: PASSWORD }) });
  const response = await runtime.fetch('/api/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshot: createEmptySnapshot(), expectedVersion: 0 }) });
  expect(response.status).toBe(503);
  expect((await response.json()).message).toContain('尚未导入');
  const { events } = await (await runtime.fetch('/api/audit')).json();
  expect(events).toEqual([{ time: expect.any(String), operation: 'restore', result: 'not-initialized', version: 0 }]);
});

it('审计按写入和导出分流分页，导出不挤掉写入历史', async () => {
  await runtime.fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: PASSWORD }) });
  const insert = runtime.db.db.prepare("INSERT INTO audit_event(time, operation, result, version) VALUES ('2026-10-08T00:00:00Z', ?, 'success', ?)");
  for (let version = 1; version <= 102; version++) insert.run('save', version);
  for (let index = 0; index < 105; index++) insert.run('backup', 4);
  const first = await (await runtime.fetch('/api/audit')).json();
  expect(first.events).toHaveLength(100);
  expect(first.events[0]).toMatchObject({ operation: 'save', version: 102 });
  expect(first.nextCursor).not.toBeNull();
  const second = await (await runtime.fetch(`/api/audit?before=${first.nextCursor}`)).json();
  expect(second.events.map((event: { version: number }) => event.version)).toEqual([2, 1]);
  expect(second.nextCursor).toBeNull();
  const exports = await (await runtime.fetch('/api/audit?kind=backup')).json();
  expect(exports.events.every((event: { operation: string }) => event.operation === 'backup')).toBe(true);
});

it('导出审计和写入审计分别有保留上限，仍能遍历全部保留记录', async () => {
  await runtime.fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: PASSWORD }) });
  const insert = runtime.db.db.prepare("INSERT INTO audit_event(time, operation, result, version) VALUES ('2026-10-08T00:00:00Z', ?, 'success', ?)");
  for (let version = 1; version <= 10001; version++) insert.run('save', version);
  for (let index = 0; index < 1001; index++) insert.run('backup', 4);
  await recordBackup(runtime.db, 4, new Date().toISOString());
  const readAll = async (kind: string) => {
    const events: Array<{ version: number }> = [];
    let cursor: string | null = null;
    do {
      const page = await (await runtime.fetch(`/api/audit?kind=${kind}${cursor ? `&before=${cursor}` : ''}`)).json();
      events.push(...page.events);
      cursor = page.nextCursor;
    } while (cursor);
    return events;
  };
  const writes = await readAll('write');
  expect(writes).toHaveLength(10000);
  expect(writes.at(-1)?.version).toBe(2);
  expect(await readAll('backup')).toHaveLength(1000);
});

it('实际写入已落库而元数据缺失时，不把成功审计改为失败', async () => {
  class UnreportedWrite extends SqliteD1 {
    override async batch(statements: D1Statement[]) {
      const results = await super.batch(statements);
      results[0] = { meta: {} };
      return results;
    }
  }
  runtime.close();
  runtime = new CloudflareRuntime({ credential, db: new UnreportedWrite() });
  runtime.db.seed(JSON.stringify(createEmptySnapshot()), 2);
  await runtime.fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: PASSWORD }) });
  const response = await runtime.fetch('/api/snapshot', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshot: createEmptySnapshot(), expectedVersion: 2 }) });
  expect(response.status).toBe(503);
  expect((await (await runtime.fetch('/api/owner-snapshot')).json()).version).toBe(3);
  const { events } = await (await runtime.fetch('/api/audit')).json();
  expect(events).toEqual([{ time: expect.any(String), operation: 'save', result: 'success', version: 3 }]);
});

it('导出过于频繁时返回限流，且不影响本人保存预算', async () => {
  await runtime.fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: PASSWORD }) });
  for (let index = 0; index < 30; index++) expect((await runtime.fetch('/api/backup')).status).toBe(200);
  const refused = await runtime.fetch('/api/backup');
  expect(refused.status).toBe(429);
  expect(refused.headers.get('retry-after')).not.toBeNull();
  const { events } = await (await runtime.fetch('/api/audit?kind=backup')).json();
  expect(events).toHaveLength(30);
  expect((await runtime.fetch('/api/snapshot', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshot: createEmptySnapshot(), expectedVersion: 4 }) })).status).toBe(200);
});

it('审计游标与分类只接受明确的合法值', async () => {
  await runtime.fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: PASSWORD }) });
  for (const query of ['before=0', 'before=-1', 'before=1.5', 'before=1%20OR%201=1', 'kind=public']) {
    expect((await runtime.fetch(`/api/audit?${query}`)).status).toBe(400);
  }
});

it('新会话不能绕过同一 IP 的导出预算，窗口到期后恢复', async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  const login = () => runtime.fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: PASSWORD }) });
  await login();
  for (let index = 0; index < 30; index++) expect((await runtime.fetch('/api/backup')).status).toBe(200);
  await login();
  expect((await runtime.fetch('/api/backup')).status).toBe(429);
  clock.mockReturnValue(now + 60_001);
  expect((await runtime.fetch('/api/backup')).status).toBe(200);
});
