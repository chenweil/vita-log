import { describe, expect, it } from 'vitest';
import { ReadOnlyEditorAuth, type UnlockResult } from '../src/auth';
import { ServerEditorAuth } from '../src/server-auth';

/**
 * What a failed attempt would show. A successful one carries no message at all,
 * which is why this has to narrow before it can read `message`.
 */
const failure = (result: UnlockResult): string => {
  if (result.outcome === 'unlocked') throw new Error('expected the login to fail');
  return result.message;
};

/**
 * The four things a login attempt can be, and the only one of them the owner
 * can act on by changing their own input.
 *
 * The old contract returned a boolean, so a 503, a rate limit, a dropped
 * connection and a typo in the password all arrived as the same `false` — and
 * the page, having nothing else to work with, told the owner their password was
 * wrong.
 */
describe('editor auth contract', () => {
  it('never claims a credential was refused, whatever credentials are offered', async () => {
    // The page never asks a read-only deployment to unlock, so this path is
    // unreachable in the product — which is exactly why it needs an assertion.
    // "The outcome is not `unlocked`" is far too weak: swapping this for the
    // old defect (`rejected` plus "账号或密码错误") leaves every suite green,
    // because nothing has ever walked here.
    const auth = new ReadOnlyEditorAuth();

    const result = await auth.unlock('owner', 'long-password');
    expect(result.outcome).not.toBe('unlocked');
    // What matters: this deployment never evaluates a password, so it must never
    // have an opinion about one.
    expect(failure(result)).not.toContain('账号或密码错误');
    expect(failure(result)).toContain('没有编辑入口');
    expect(auth.isUnlocked()).toBe(false);
  });

  it('stays read-only after lock, so a session cannot be revived client-side', () => {
    const auth = new ReadOnlyEditorAuth();

    auth.lock();

    expect(auth.isUnlocked()).toBe(false);
  });
});

describe('ServerEditorAuth 结果分类', () => {
  const NOW = 1_000_000;
  const errorResponse = (status: number, body: unknown): Response => Response.json(body, { status });

  /** A client that answers the session probe, then the login, as told. */
  const client = (login: () => Promise<Response>, session: () => Promise<Response> = () => Promise.resolve(Response.json({ loggedIn: false, until: 0 }))) => ({
    fetch: async (input: RequestInfo | URL): Promise<Response> => (String(input) === '/api/session' ? session() : login()),
  });

  it('凭据被拒与限流共用一个 code，只能靠 HTTP 状态区分', async () => {
    // Both backends answer a rate limit with `code: 'unauthorized'` — the same
    // code a wrong password gets. Classifying on the body would fold the limit
    // back into "your password is wrong".
    const rejected = await new ServerEditorAuth(client(() => Promise.resolve(errorResponse(401, { code: 'unauthorized', message: '账号或密码错误' }))), () => NOW).unlock('owner', 'wrong-password-here');
    const limited = await new ServerEditorAuth(client(() => Promise.resolve(errorResponse(429, { code: 'unauthorized', message: '尝试次数过多，请一分钟后重试' }))), () => NOW).unlock('owner', 'wrong-password-here');

    expect(rejected.outcome).toBe('rejected');
    expect(limited.outcome).toBe('limited');
  });

  it('服务端原文优先于客户端默认文案', async () => {
    const result = await new ServerEditorAuth(client(() => Promise.resolve(errorResponse(503, { code: 'database-unavailable', message: '健康数据服务暂时不可用，请稍后重试' }))), () => NOW).unlock('owner', 'the-right-password');

    expect(result.outcome).toBe('unavailable');
    expect(failure(result)).toBe('健康数据服务暂时不可用，请稍后重试');
  });

  it('限流没有原文时，客户端的默认文案也不得说成密码错误', async () => {
    // Both backends send a message today, but a proxy or a WAF in front of them
    // may answer 429 with an empty body. That is exactly where a mislabelled
    // outcome turns back into the old defect: the page falls back to this
    // deployment's default wording, so the default has to be right too.
    const result = await new ServerEditorAuth(client(() => Promise.resolve(new Response('', { status: 429 }))), () => NOW).unlock('owner', 'the-right-password');

    expect(result.outcome).toBe('limited');
    expect(failure(result)).not.toContain('账号或密码错误');
    expect(failure(result), '限流的修复动作是稍后再试').toContain('稍后再试');
  });

  it('输入不合规算被拒，不算服务故障', async () => {
    // The self-hosted server answers a too-short password with 400
    // validation-failed. That is the owner's input to fix, so it must not be
    // filed under "the service is down".
    const result = await new ServerEditorAuth(client(() => Promise.resolve(errorResponse(400, { code: 'validation-failed', message: '请填写账号和至少 10 字符的密码' }))), () => NOW).unlock('owner', 'short');

    expect(result.outcome).toBe('rejected');
    expect(failure(result)).toBe('请填写账号和至少 10 字符的密码');
  });

  it('网络失败归入服务不可用，且不得出现「账号或密码错误」', async () => {
    const dropped = await new ServerEditorAuth(client(() => Promise.reject(new Error('connection reset'))), () => NOW).unlock('owner', 'the-right-password');

    expect(dropped.outcome).toBe('unavailable');
    expect(failure(dropped)).not.toContain('账号或密码错误');
    // And the owner still has to be told the attempt did not get anywhere.
    expect(failure(dropped)).toContain('重试');
  });

  it('会话探测本身就失败时，也按服务不可用处理', async () => {
    // The probe runs first, so a service that cannot even answer
    // `/api/session` never reaches the login POST. Reporting that as a
    // rejected credential would blame the owner for the server being down.
    const result = await new ServerEditorAuth(client(
      () => Promise.resolve(errorResponse(401, { code: 'unauthorized', message: '账号或密码错误' })),
      () => Promise.resolve(errorResponse(503, { code: 'database-unavailable', message: '健康数据服务暂时不可用，请稍后重试' })),
    ), () => NOW).unlock('owner', 'the-right-password');

    expect(result.outcome).toBe('unavailable');
    expect(failure(result)).toContain('服务');
  });

  it('登录返回 200 但响应体无法识别时，同样算服务不可用', async () => {
    // Not just "not JSON". A 200 carrying a body this client cannot read — no
    // deadline, or none of the shape it expects — is equally not evidence of a
    // session, and reporting it as one closes the modal and sends the page off
    // to reload as though it held owner rights.
    const unreadable = [
      new Response('not json', { status: 200 }),
      Response.json({}, { status: 200 }),
      Response.json({ loggedIn: true }, { status: 200 }),
      Response.json({ until: null }, { status: 200 }),
    ];

    for (const response of unreadable) {
      const auth = new ServerEditorAuth(client(() => Promise.resolve(response.clone())), () => NOW);
      const result = await auth.unlock('owner', 'the-right-password');
      expect(result.outcome, `${response.status} ${await response.text()}`).toBe('unavailable');
      expect(failure(result)).not.toContain('账号或密码错误');
      expect(auth.isUnlocked()).toBe(false);
    }
  });

  it('每一种失败的默认文案都由它自己的类别决定', async () => {
    // This is where the classification is actually load-bearing: both backends
    // send a message today, so the page shows their wording and a mislabelled
    // outcome would go unnoticed there. With no message to fall back on, the
    // default for the *named* outcome is all that is left — so a limit that
    // called itself a rejected credential would put "账号或密码错误" straight
    // back on screen, which is the defect this contract exists to remove.
    const bare = (status: number): Response => new Response('', { status });
    const cases = [
      [401, 'rejected', '账号或密码错误'],
      [429, 'limited', '稍后再试'],
      [503, 'unavailable', '不可用'],
    ] as const;

    for (const [status, outcome, expected] of cases) {
      const result = await new ServerEditorAuth(client(() => Promise.resolve(bare(status))), () => NOW).unlock('owner', 'the-right-password');
      expect(result.outcome, `status ${status}`).toBe(outcome);
      expect(failure(result), `status ${status}`).toContain(expected);
    }
  });

  it.each([
    {}, null, [],
    { loggedIn: 'false', until: NOW + 60_000 },
    { loggedIn: true, until: String(NOW + 60_000) },
    { loggedIn: false },
    { loggedIn: false, until: -1 },
    { loggedIn: false, until: NOW + 60_000 },
    { loggedIn: true, until: NOW },
    { loggedIn: true, until: NOW - 1 },
  ])('无法识别或已过期的会话探测不继续登录：%j', async (body) => {
    let loginPosts = 0;
    const auth = new ServerEditorAuth(client(
      () => { loginPosts += 1; return Promise.resolve(errorResponse(401, { message: '账号或密码错误' })); },
      () => Promise.resolve(Response.json(body)),
    ), () => NOW);

    const result = await auth.unlock('owner', 'the-right-password');

    expect(result.outcome).toBe('unavailable');
    expect(failure(result)).not.toContain('账号或密码错误');
    expect(auth.isUnlocked()).toBe(false);
    expect(loginPosts).toBe(0);
  });

  it.each([0, -1, NOW - 1, NOW, String(NOW + 60_000)])('登录期限无效或已过期时不能宣称解锁：%j', async (until) => {
    const auth = new ServerEditorAuth(client(() => Promise.resolve(Response.json({ until }))), () => NOW);

    const result = await auth.unlock('owner', 'the-right-password');

    expect(result.outcome).toBe('unavailable');
    expect(failure(result)).not.toContain('账号或密码错误');
    expect(auth.isUnlocked()).toBe(false);
  });

  it('有效的未登录探测可以继续登录，并取得未来期限', async () => {
    const auth = new ServerEditorAuth(client(() => Promise.resolve(Response.json({ loggedIn: true, until: NOW + 60_000 }))), () => NOW);

    expect(await auth.unlock('owner', 'the-right-password')).toEqual({ outcome: 'unlocked' });
    expect(auth.isUnlocked()).toBe(true);
  });

  it('未锁定的服务端会话直接算解锁成功', async () => {
    const auth = new ServerEditorAuth(client(
      () => Promise.resolve(new Response('never called', { status: 500 })),
      () => Promise.resolve(Response.json({ loggedIn: true, until: NOW + 60_000 })),
    ), () => NOW);

    expect(await auth.unlock('owner', 'whatever-password')).toMatchObject({ outcome: 'unlocked' });
    expect(auth.isUnlocked()).toBe(true);
  });
});
