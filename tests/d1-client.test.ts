import { describe, expect, it } from 'vitest';
import { createEmptySnapshot, type HealthSnapshot } from '../src/domain';
import { createPublicSnapshot } from '../src/public-snapshot';
import { D1HealthRepository } from '../src/d1-storage';
import { StorageError } from '../src/storage';

class FakeClient {
  calls: Array<{ input: string; init?: RequestInit }> = [];
  responses: Response[] = [];
  private offline = false;
  failNext(): void { this.offline = true; }
  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    this.calls.push({ input: String(input), init });
    if (this.offline) throw new Error('offline');
    const next = this.responses.shift();
    if (!next) throw new Error('no queued response');
    return next;
  }
}

const ownerSnapshot = (): HealthSnapshot => {
  const snapshot = createEmptySnapshot('2026-10-05T08:00:00.000Z');
  snapshot.settings.name = '轻盈';
  snapshot.weights = [{ id: 'w1', date: '2026-10-01', weightKg: 76.4, bodyfatPercent: 21.5, note: '晨起空腹', createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-01T08:00:00.000Z' }];
  return snapshot;
};

const ok = (): Response => new Response(JSON.stringify(createPublicSnapshot(ownerSnapshot())), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const failWith = (code: string, message: string, status = 503): Response => Response.json({ code, message }, { status, headers: { 'cache-control': 'no-store' } });

describe('D1 公开读取浏览器适配器', () => {
  it('匿名读取公开投影并还原为看板快照', async () => {
    const client = new FakeClient();
    client.responses.push(ok());
    const result = await new D1HealthRepository(client).load();
    expect(result.status).toBe('loaded');
    expect(result.snapshot.settings.name).toBe('轻盈');
    expect(result.snapshot.weights[0].weightKg).toBe(76.4);
    expect(result.snapshot.weights[0].note).toBe('晨起空腹');
    expect(result.snapshot.updatedAt).toBe('2026-10-05T08:00:00.000Z');
  });

  it('请求同源 /api/snapshot 且禁用客户端缓存', async () => {
    const client = new FakeClient();
    client.responses.push(ok());
    await new D1HealthRepository(client).load();
    expect(client.calls[0].input).toBe('/api/snapshot');
    expect(client.calls[0].init?.credentials).toBe('same-origin');
    expect(client.calls[0].init?.cache).toBe('no-store');
    expect(client.calls[0].init?.method ?? 'GET').toBe('GET');
  });

  it('数据库不可用时抛出稳定错误，不回退为空快照或旧数据', async () => {
    for (const [code, status] of [['database-unavailable', 503], ['unauthorized', 401]] as const) {
      const client = new FakeClient();
      client.responses.push(failWith(code, '健康数据服务暂时不可用，请稍后重试', status));
      const error = await new D1HealthRepository(client).load().then(() => null, (caught: unknown) => caught);
      expect(error, code).toBeInstanceOf(StorageError);
      expect((error as StorageError).code, code).toBe(code);
    }
  });

  it('网络失败与无效响应都 fail-closed，不产生空看板', async () => {
    const network = new FakeClient();
    network.failNext();
    await expect(new D1HealthRepository(network).load()).rejects.toThrow(StorageError);

    for (const body of ['', 'not json', JSON.stringify({ app: 'vita-log', schemaVersion: 1 }), JSON.stringify({ app: 'vita-log-public', publicSchemaVersion: 1, sourceSchemaVersion: 1, updatedAt: '2026-10-05T08:00:00.000Z' })]) {
      const client = new FakeClient();
      client.responses.push(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
      await expect(new D1HealthRepository(client).load(), body).rejects.toThrow(StorageError);
    }
  });

  it('只透传已知服务端错误码，未知或伪造代码降级为 database-unavailable', async () => {
    const known = new FakeClient();
    known.responses.push(failWith('version-conflict', '数据已更新', 409));
    const knownError = await new D1HealthRepository(known).load().then(() => null, (caught: unknown) => caught as StorageError);
    expect(knownError?.code).toBe('version-conflict');
    expect(knownError?.message).toBe('数据已更新');

    for (const code of ['malformed', 'write-failed', 'read-failed', '<script>', 42]) {
      const client = new FakeClient();
      client.responses.push(failWith(String(code), '伪造错误', 500));
      const error = await new D1HealthRepository(client).load().then(() => null, (caught: unknown) => caught as StorageError);
      expect(error?.code, String(code)).toBe('database-unavailable');
    }
  });

  it('错误响应体不是 JSON 时使用稳定提示，不暴露解析错误', async () => {
    const client = new FakeClient();
    client.responses.push(new Response('<html>502</html>', { status: 503 }));
    const error = await new D1HealthRepository(client).load().then(() => null, (caught: unknown) => caught as StorageError);
    expect(error?.code).toBe('database-unavailable');
    expect(error?.message).toBe('健康数据服务暂时不可用，请稍后重试');
  });

  it('读取路径不发起第二个请求（不回退到本机存储）', async () => {
    const client = new FakeClient();
    client.responses.push(ok());
    await new D1HealthRepository(client).load();
    expect(client.calls).toHaveLength(1);
  });

  it('公开读取阶段不提供写入与恢复能力', async () => {
    const repository = new D1HealthRepository(new FakeClient());
    await expect(repository.commit(ownerSnapshot())).rejects.toThrow(StorageError);
    await expect(repository.loadRecovery()).rejects.toThrow(StorageError);
  });
});
