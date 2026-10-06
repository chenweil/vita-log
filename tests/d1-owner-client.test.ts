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
  const loadOwner = async (client: FakeClient, version: number): Promise<D1HealthRepository> => {
    client.responses.push(Response.json({ snapshot: ownerSnapshot(), version }));
    const repository = new D1HealthRepository(client);
    await repository.load();
    return repository;
  };

  it('绑定读取快照的版本，会话报告新版本也不能推进 expectedVersion', async () => {
    const client = new FakeClient();
    const repository = await loadOwner(client, 7);
    client.responses.push(sessionState(true, 99));
    client.responses.push(Response.json({ version: 8 }));
    await repository.commit(ownerSnapshot());
    expect(client.calls.map(call => call.input)).toEqual(['/api/owner-snapshot', '/api/session', '/api/snapshot']);
    expect(client.calls[2]!.init?.body).toContain('"expectedVersion":7');
    expect(repository.currentVersion).toBe(8);
  });

  it('未登录时写入被拒绝，且不发出保存请求', async () => {
    const client = new FakeClient();
    client.responses.push(sessionState(false, 0));
    await expect(new D1HealthRepository(client).commit(ownerSnapshot())).rejects.toMatchObject({ code: 'unauthorized' });
    expect(client.calls).toHaveLength(1);
  });

  it('未读取完整编辑快照时，即使登录也拒绝保存', async () => {
    const client = new FakeClient();
    client.responses.push(sessionState(true, 7));
    await expect(new D1HealthRepository(client).commit(ownerSnapshot())).rejects.toMatchObject({ code: 'version-conflict' });
    expect(client.calls).toHaveLength(1);
  });

  it('版本冲突保留本地版本和未提交输入', async () => {
    const client = new FakeClient();
    const repository = await loadOwner(client, 3);
    client.responses.push(sessionState(true, 4));
    client.responses.push(failWith('version-conflict', '数据已更新，请重新加载；未提交输入已保留', 409));
    const input = ownerSnapshot();
    input.settings.name = '未提交';
    await expect(repository.commit(input)).rejects.toMatchObject({ code: 'version-conflict', message: '数据已更新，请重新加载；未提交输入已保留' });
    expect(repository.currentVersion).toBe(3);
    expect(input.settings.name).toBe('未提交');
  });

  it('保存成功后下一次写入带上返回版本', async () => {
    const client = new FakeClient();
    const repository = await loadOwner(client, 1);
    client.responses.push(sessionState(true, 99), Response.json({ version: 2 }));
    await repository.commit(ownerSnapshot());
    client.responses.push(sessionState(true, 99), Response.json({ version: 3 }));
    await repository.commit(ownerSnapshot());
    expect(client.calls[4]?.init?.body).toContain('"expectedVersion":2');
    expect(repository.currentVersion).toBe(3);
  });

  it('编辑读取故障不回落公开数据，损坏版本不授予写能力', async () => {
    for (const response of [failWith('database-unavailable', '不可用', 503), Response.json({ snapshot: ownerSnapshot() }), Response.json({ snapshot: ownerSnapshot(), version: '4' })]) {
      const client = new FakeClient();
      client.responses.push(response);
      const repository = new D1HealthRepository(client);
      await expect(repository.load()).rejects.toThrow(StorageError);
      expect(client.calls).toHaveLength(1);
      expect(repository.currentVersion).toBeNull();
    }
  });

  it('会话及保存故障都 fail-closed', async () => {
    const offline = new FakeClient();
    offline.failNext();
    await expect(new D1HealthRepository(offline).commit(ownerSnapshot())).rejects.toThrow(StorageError);
    const client = new FakeClient();
    const repository = await loadOwner(client, 1);
    client.responses.push(failWith('database-unavailable', '不可用', 503));
    await expect(repository.commit(ownerSnapshot())).rejects.toThrow(StorageError);
    client.responses.push(sessionState(true, 99), new Response('<html>502</html>', { status: 502 }));
    await expect(repository.commit(ownerSnapshot())).rejects.toThrow(StorageError);
    expect(repository.currentVersion).toBe(1);
  });

  it('保存成功响应缺失或错误版本时要求重载，不猜测下一版本', async () => {
    for (const version of [undefined, '2', 1, 99]) {
      const client = new FakeClient();
      const repository = await loadOwner(client, 1);
      client.responses.push(sessionState(true, 1), Response.json({ version }));
      await expect(repository.commit(ownerSnapshot())).rejects.toThrow(StorageError);
      expect(repository.currentVersion).toBeNull();
    }
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
    const auth = new ServerEditorAuth(client, () => 1_000);
    expect(await auth.unlock('owner', 'a long owner password')).toBe(true);
    expect(auth.isUnlocked()).toBe(true);
    expect(client.calls.map(call => call.input)).toEqual(['/api/session', '/api/login']);
  });

  it('锁定调用注销并在服务端确认后变为只读', async () => {
    const client = new FakeClient();
    client.responses.push(Response.json({ loggedIn: true, until: 60_000 }));
    client.responses.push(Response.json({ loggedIn: false }));
    const auth = new ServerEditorAuth(client, () => 1_000);
    await auth.unlock('owner', 'a long owner password');
    expect(auth.isUnlocked()).toBe(true);
    await auth.lock();
    expect(auth.isUnlocked()).toBe(false);
    expect(client.calls.at(-1)?.input).toBe('/api/logout');
  });

  it('注销失败时不谎报已锁定', async () => {
    // The cookie outlives this call. If the revocation never lands, the session
    // is still usable for the rest of its TTL, and a page that has already
    // hidden its controls would be telling the owner they are safe when they
    // are not. Staying unlocked is the honest outcome.
    // Two ways it can fail to land: the server answers with an error, or the
    // request never completes at all.
    const refused = new FakeClient();
    refused.responses.push(Response.json({ loggedIn: true, until: 60_000, version: 3 }));
    await assertStillUnlocked(refused, () => {
      refused.responses.push(failWith('database-unavailable', '健康数据服务暂时不可用，请稍后重试', 503));
    });

    const offline = new FakeClient();
    offline.responses.push(Response.json({ loggedIn: true, until: 60_000, version: 3 }));
    await assertStillUnlocked(offline, () => offline.failNext());
  });

  /**
   * Unlock first, then break only the lock. The failure is introduced after the
   * session exists, so the case really is "a live session whose revocation did
   * not land" rather than "a client that was never logged in".
   */
  const assertStillUnlocked = async (client: FakeClient, breakLock: () => void): Promise<void> => {
    const auth = new ServerEditorAuth(client, () => 1_000);
    expect(await auth.unlock('owner', 'a long owner password')).toBe(true);
    expect(auth.isUnlocked()).toBe(true);
    breakLock();
    // Never rejects, so a caller that fires and forgets cannot produce an
    // unhandled rejection.
    await expect(auth.lock()).resolves.toBeUndefined();
    expect(auth.isUnlocked()).toBe(true);
    expect(client.calls.at(-1)?.input).toBe('/api/logout');
  };

  it('会话已存在时不重复登录', async () => {
    const client = new FakeClient();
    client.responses.push(Response.json({ loggedIn: true, until: 60_000, version: 4 }));
    const auth = new ServerEditorAuth(client, () => 1_000);
    expect(await auth.unlock('owner', 'a long owner password')).toBe(true);
    expect(client.calls).toHaveLength(1);
  });

  it('登录失败时保持只读', async () => {
    const client = new FakeClient();
    client.responses.push(Response.json({ loggedIn: false, until: 0, version: 0 }));
    client.responses.push(failWith('unauthorized', '账号或密码错误', 401));
    const auth = new ServerEditorAuth(client, () => 1_000);
    expect(await auth.unlock('owner', 'wrong')).toBe(false);
    expect(auth.isUnlocked()).toBe(false);
  });

  it('会话响应缺少 configured 字段也不会回落到 setup', async () => {
    // The Cloudflare session endpoint has no setup concept to report. A client
    // that branched on `configured` would treat its absence as "not set up yet"
    // and reach for a route that must not exist. There is no such branch now.
    const client = new FakeClient();
    client.responses.push(Response.json({ loggedIn: false, until: 0, version: 0 }));
    client.responses.push(Response.json({ loggedIn: true, until: 60_000 }));
    const auth = new ServerEditorAuth(client, () => 1_000);
    expect(await auth.unlock('owner', 'a long owner password')).toBe(true);
    expect(client.calls.map((call) => call.input)).toEqual(['/api/session', '/api/login']);
  });
});
