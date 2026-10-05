import { describe, expect, it } from 'vitest';
import { createEmptySnapshot, type HealthSnapshot } from '../src/domain';
import { D1HealthRepository } from '../src/d1-storage';
import { ServerEditorAuth } from '../src/server-auth';
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
    if (!next) throw new Error(`no queued response for ${String(input)}`);
    return next;
  }
}

const ownerSnapshot = (): HealthSnapshot => {
  const snapshot = createEmptySnapshot('2026-10-05T08:00:00.000Z');
  snapshot.settings.name = '轻盈';
  return snapshot;
};

const sessionState = (loggedIn: boolean, version: number): Response => Response.json({ loggedIn, until: loggedIn ? 60_000 : 0, version });
const failWith = (code: string, message: string, status: number): Response => Response.json({ code, message }, { status, headers: { 'cache-control': 'no-store' } });

describe('D1 owner 写入浏览器适配器', () => {
  it('写入前先取会话与版本，再带 expectedVersion 保存', async () => {
    const client = new FakeClient();
    client.responses.push(sessionState(true, 7));
    client.responses.push(Response.json({ version: 8, savedAt: '2026-10-06T09:00:00.000Z' }));
    await new D1HealthRepository(client).commit(ownerSnapshot());
    expect(client.calls.map(call => call.input)).toEqual(['/api/session', '/api/snapshot']);
    const save = client.calls[1]!;
    expect(save.init?.method).toBe('PUT');
    expect(save.init?.credentials).toBe('same-origin');
    expect(save.init?.body).toContain('"expectedVersion":7');
  });

  it('未登录时写入被拒绝，且不发出保存请求', async () => {
    const client = new FakeClient();
    client.responses.push(sessionState(false, 0));
    const error = await new D1HealthRepository(client).commit(ownerSnapshot()).then(() => null, (caught: unknown) => caught as StorageError);
    expect(error).toBeInstanceOf(StorageError);
    expect(error?.code).toBe('unauthorized');
    expect(client.calls).toHaveLength(1);
  });

  it('版本冲突透传稳定错误码与服务端文案，保留未提交输入', async () => {
    const client = new FakeClient();
    client.responses.push(sessionState(true, 3));
    client.responses.push(failWith('version-conflict', '数据已更新，请重新加载；未提交输入已保留', 409));
    const repository = new D1HealthRepository(client);
    const error = await repository.commit(ownerSnapshot()).then(() => null, (caught: unknown) => caught as StorageError);
    expect(error?.code).toBe('version-conflict');
    expect(error?.message).toBe('数据已更新，请重新加载；未提交输入已保留');
    // The repository holds no local copy to discard, so a refused save cannot
    // have thrown away what the owner typed.
    expect(repository.currentVersion).toBe(0);
  });

  it('保存成功后记住新版本，下一次写入带上它', async () => {
    const client = new FakeClient();
    client.responses.push(sessionState(true, 1));
    client.responses.push(Response.json({ version: 2, savedAt: '2026-10-06T09:00:00.000Z' }));
    const repository = new D1HealthRepository(client);
    await repository.commit(ownerSnapshot());
    expect(repository.currentVersion).toBe(2);

    client.responses.push(sessionState(true, 2));
    client.responses.push(Response.json({ version: 3, savedAt: '2026-10-06T10:00:00.000Z' }));
    await repository.commit(ownerSnapshot());
    expect(client.calls[3]?.init?.body).toContain('"expectedVersion":2');
  });

  it('会话与保存都 fail-closed：传输失败和非 2xx 都抛出', async () => {
    const offline = new FakeClient();
    offline.failNext();
    await expect(new D1HealthRepository(offline).commit(ownerSnapshot())).rejects.toThrow(StorageError);

    const noSession = new FakeClient();
    noSession.responses.push(failWith('database-unavailable', '健康数据服务暂时不可用，请稍后重试', 503));
    await expect(new D1HealthRepository(noSession).commit(ownerSnapshot())).rejects.toThrow(StorageError);

    const brokenSave = new FakeClient();
    brokenSave.responses.push(sessionState(true, 1));
    brokenSave.responses.push(new Response('<html>502</html>', { status: 502 }));
    await expect(new D1HealthRepository(brokenSave).commit(ownerSnapshot())).rejects.toThrow(StorageError);
  });

  it('恢复快照仍不可用：恢复属 06.1-05', async () => {
    await expect(new D1HealthRepository(new FakeClient()).loadRecovery()).rejects.toThrow(StorageError);
  });
});

describe('Cloudflare 模式的编辑会话客户端', () => {
  it('登录只走 /api/login，绝不调用公网 setup 接口', async () => {
    const client = new FakeClient();
    // `configured` is absent, which is exactly what the Cloudflare session
    // endpoint returns — it has no setup concept to report.
    client.responses.push(Response.json({ loggedIn: false, until: 0, version: 0 }));
    client.responses.push(Response.json({ loggedIn: true, until: 60_000 }));
    const auth = new ServerEditorAuth(client, () => 1_000, { allowSetup: false });
    expect(await auth.unlock('owner', 'a long owner password')).toBe(true);
    expect(auth.isUnlocked()).toBe(true);
    expect(client.calls.map(call => call.input)).toEqual(['/api/session', '/api/login']);
  });

  it('锁定调用注销并立即变为只读', async () => {
    const client = new FakeClient();
    client.responses.push(Response.json({ loggedIn: true, until: 60_000 }));
    client.responses.push(Response.json({ loggedIn: false }));
    const auth = new ServerEditorAuth(client, () => 1_000, { allowSetup: false });
    await auth.unlock('owner', 'a long owner password');
    expect(auth.isUnlocked()).toBe(true);
    auth.lock();
    expect(auth.isUnlocked()).toBe(false);
    expect(client.calls.at(-1)?.input).toBe('/api/logout');
  });

  it('会话已存在时不重复登录', async () => {
    const client = new FakeClient();
    client.responses.push(Response.json({ loggedIn: true, until: 60_000, version: 4 }));
    const auth = new ServerEditorAuth(client, () => 1_000, { allowSetup: false });
    expect(await auth.unlock('owner', 'a long owner password')).toBe(true);
    expect(client.calls).toHaveLength(1);
  });

  it('登录失败时保持只读', async () => {
    const client = new FakeClient();
    client.responses.push(Response.json({ loggedIn: false, until: 0, version: 0 }));
    client.responses.push(failWith('unauthorized', '账号或密码错误', 401));
    const auth = new ServerEditorAuth(client, () => 1_000, { allowSetup: false });
    expect(await auth.unlock('owner', 'wrong')).toBe(false);
    expect(auth.isUnlocked()).toBe(false);
  });

  it('自托管模式仍保留 setup 回退，未改动既有行为', async () => {
    const client = new FakeClient();
    client.responses.push(Response.json({ configured: false, loggedIn: false, until: 0 }));
    client.responses.push(Response.json({ until: 60_000 }));
    const auth = new ServerEditorAuth(client, () => 1_000);
    expect(await auth.unlock('owner', 'a long owner password')).toBe(true);
    expect(client.calls[1]?.input).toBe('/api/setup');
  });
});
