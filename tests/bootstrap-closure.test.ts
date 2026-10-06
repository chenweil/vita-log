import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes, scryptSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { createApi } from '../server/api';
import { SqliteStore } from '../server/store';
import { createEmptySnapshot } from '../src/domain';
import { ReadOnlyEditorAuth } from '../src/auth';
import { stripComments } from './support/strip-comments';

const projectRoot = new URL('../', import.meta.url).pathname;
const sourceFiles = (directory: string, extensions = ['.ts']): string[] => {
  const entries = readdirSync(join(projectRoot, directory), { withFileTypes: true })
    .filter((entry) => entry.isFile() && extensions.includes(`.${entry.name.split('.').pop()}`));
  return entries.map((entry) => join(projectRoot, directory, entry.name));
};

/** Provision the owner the way the ops command does, so login can succeed. */
const provision = (store: SqliteStore, username: string, password: string): void => {
  const salt = randomBytes(16).toString('hex');
  store.setOwnerCredentials(username, salt, scryptSync(password, salt, 64).toString('hex'));
};

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'vita-bootstrap-'));
  const store = new SqliteStore({ database: join(root, 'data.sqlite'), backups: join(root, 'backups') });
  return { root, store, api: createApi(store, () => 1_000_000) };
}

// The Origin has to match the request's own origin. The goal is to exercise
// route existence, not the same-origin guard — a 403 from that guard would pass
// every assertion below while the route was still wide open.
const ORIGIN = 'http://127.0.0.1';

const login = async (api: ReturnType<typeof createApi>, username: string, password: string): Promise<string> => {
  const response = await post(api, '/api/login', { username, password });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie') ?? '';
};

const post = (api: ReturnType<typeof createApi>, path: string, body: unknown = { username: 'attacker', password: 'a long enough password' }) =>
  api(new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify(body),
  }));

describe('公网不存在管理员初始化或密码找回路径', () => {
  it('自托管 API 不再接受 setup 请求，登录态下同样没有该路由', async () => {
    const { root, store, api } = setup();
    try {
      // The anonymous answer alone cannot tell "removed" from "gated": a
      // bootstrap endpoint that exists but refuses is one config change away
      // from accepting. So this checks both sides — anonymous, and holding a
      // valid session. Only the second one proves the branch is gone.
      const anonymous = await post(api, '/api/setup');
      expect([401, 404]).toContain(anonymous.status);
      expect(store.credentials()).toBeNull();

      provision(store, 'owner', 'a sufficiently long owner password');
      const cookie = await login(api, 'owner', 'a sufficiently long owner password');
      const authenticated = await api(new Request(`${ORIGIN}/api/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
        body: JSON.stringify({ username: 'intruder', password: 'another long password' }),
      }));
      expect(authenticated.status, '已登录时 setup 应当是 404，而不是被接受').toBe(404);
      expect(store.credentials()?.username, '账号不得被改写').toBe('owner');
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('没有注册、找回密码或重置路由，且都不会创建账号', async () => {
    const { root, store, api } = setup();
    try {
      for (const path of ['/api/register', '/api/reset', '/api/forgot', '/api/recover', '/api/password']) {
        // Unknown paths sit behind the session gate, so an anonymous caller
        // gets 401 rather than 404. That is the better of the two answers: it
        // does not tell a prober which paths exist. What matters is the
        // effect — refused, and no account appears.
        const created = await post(api, path);
        expect([401, 404], path).toContain(created.status);
        const reset = await api(new Request(`${ORIGIN}${path}`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: '{}' }));
        expect([401, 404], path).toContain(reset.status);
        expect(store.credentials(), path).toBeNull();
      }
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('重复初始化与密码重置在存储层同样被拒绝', async () => {
    // The HTTP route is gone, so this is defence in depth: if any future code
    // reached for it, the store itself refuses rather than overwriting the
    // one account. Rotation goes through the ops command instead, which is an
    // explicit act by the owner rather than a request.
    const { root, store } = setup();
    try {
      store.setup('owner', 'salt', 'hash');
      expect(() => store.setup('intruder', 'other-salt', 'other-hash')).toThrow(/已经设置/);
      expect(store.credentials()?.username).toBe('owner');
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('匿名读取不泄露是否已配置管理员', async () => {
    // `configured` rode along on both public GETs for a client branch that this
    // ticket removed. Left in place, it turns two anonymous endpoints into a
    // probe for "does this deployment have an administrator" — on this backend
    // only, since the Worker deliberately withholds the same fact.
    const { root, store, api } = setup();
    try {
      const session = await api(new Request(`${ORIGIN}/api/session`));
      expect(session.status).toBe(200);
      expect(Object.keys(await session.json() as object)).not.toContain('configured');

      provision(store, 'owner', 'a sufficiently long owner password');
      const health = await api(new Request(`${ORIGIN}/api/health`));
      expect(health.status).toBe(200);
      const body = await health.text();
      expect(body).not.toContain('configured');
      expect(body, '不得回显账号').not.toContain('owner');
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('Pages Functions 没有任何 setup 或找回路由', () => {
    const routes = readdirSync(join(projectRoot, 'functions/api'))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => name.replace(/\.ts$/, ''));
    expect(routes.sort()).toEqual(['login', 'logout', 'owner-snapshot', 'session', 'snapshot']);
    for (const route of routes) {
      const source = readFileSync(join(projectRoot, 'functions/api', `${route}.ts`), 'utf8');
      expect(source, `functions/api/${route}.ts 含 setup/注册/找回`).not.toMatch(/\/api\/(setup|register|reset|forgot|recover)\b/);
    }
  });
});

describe('浏览器客户端不会去调用初始化接口', () => {
  it('登录只走 /api/login，没有 setup 回退', () => {
    // A client that can still POST to /api/setup is an unauthenticated call to
    // a route the deployment must not have. The fallback is removed rather than
    // defaulted off, so there is nothing left to misconfigure.
    // Comments are stripped first: the module explains in prose why the fallback
    // is gone, and that explanation must not be what fails this check. The
    // pattern keeps backticks, so a template literal is not the way past it.
    const source = stripComments(readFileSync(join(projectRoot, 'src/server-auth.ts'), 'utf8'));
    expect(source).not.toMatch(/['"`]\/api\/setup['"`]/);
    expect(source).not.toContain('allowSetup');
    expect(source).toContain("'/api/login'");
  });

  it('整个浏览器源码不含 setup 路径', () => {
    for (const path of sourceFiles('src')) {
      expect(stripComments(readFileSync(path, 'utf8')), path).not.toMatch(/['"`]\/api\/setup['"`]/);
    }
  });
});

describe('纯静态模式只读且不含凭据材料', () => {
  it('源码不再定义 DEFAULT_EDITOR_AUTH 或任何用户名/盐/摘要常量', () => {
    for (const path of [...sourceFiles('src'), ...sourceFiles('server'), ...sourceFiles('functions')]) {
      const source = readFileSync(path, 'utf8');
      expect(source, `${path} 含 DEFAULT_EDITOR_AUTH`).not.toContain('DEFAULT_EDITOR_AUTH');
      // A non-empty literal for any of these is a credential in the bundle.
      expect(source, `${path} 含硬编码 passwordHash`).not.toMatch(/passwordHash:\s*['"][^'"]+['"]/);
      expect(source, `${path} 含硬编码 salt`).not.toMatch(/salt:\s*['"][^'"]+['"]/);
    }
  });

  it('localStorage 模式挂载时默认只读', () => {
    // mountApp's default auth is what the static build gets: ReadOnlyEditorAuth
    // never unlocks, so there is no editor entry point to gate.
    const source = readFileSync(join(projectRoot, 'src/app.ts'), 'utf8');
    expect(source).toContain('auth: EditorAuth = new ReadOnlyEditorAuth()');
    expect(new ReadOnlyEditorAuth().isUnlocked()).toBe(false);
  });

  it('main.ts 的静态分支不注入任何认证实现', () => {
    // The property is "this call passes no auth argument", so the window has to
    // be the whole call. A fixed-length slice past the match passes just as
    // happily for a third argument sitting beyond its end.
    const source = readFileSync(join(projectRoot, 'src/main.ts'), 'utf8');
    const start = source.indexOf('mountApp(container, new LocalStorageHealthRepository');
    expect(start, '未找到 localStorage 挂载分支').toBeGreaterThan(-1);
    const open = source.indexOf('(', start);
    let depth = 0;
    let close = open;
    let argumentsAtTopLevel = 1;
    for (; close < source.length; close += 1) {
      const character = source[close];
      if (character === '(' || character === '{' || character === '[') depth += 1;
      else if (character === ')' || character === '}' || character === ']') {
        depth -= 1;
        if (depth === 0) break;
      } else if (character === ',' && depth === 1) argumentsAtTopLevel += 1;
    }
    expect(close, '未能匹配到 mountApp 调用的右括号').toBeLessThan(source.length);
    const call = source.slice(open + 1, close);
    expect(call, '静态分支不得传入认证实现').not.toMatch(/Auth/);
    // Container and repository, and nothing else: a third argument is exactly
    // the auth this build must not receive.
    expect(argumentsAtTopLevel, `静态分支传了 ${argumentsAtTopLevel} 个参数`).toBe(2);
  });
});

describe('直接写 API 的未授权调用被拒绝（复验 06.1-02a）', () => {
  it('没有会话时写入被拒绝，且不改动已保存数据', async () => {
    // Re-verified here rather than assumed: 02b's acceptance depends on it, and
    // an earlier pass at "the write path is protected" would have passed
    // vacuously while no write authorization existed at all.
    const { root, store, api } = setup();
    try {
      await post(api, '/api/setup');
      const saved = store.commit(createEmptySnapshot(), 0);
      const denied = await api(new Request(`${ORIGIN}/api/snapshot`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ snapshot: createEmptySnapshot(), expectedVersion: saved.version }),
      }));
      expect(denied.status).toBe(401);
      expect((await denied.json() as { code: string }).code).toBe('unauthorized');
      expect(store.load().version).toBe(saved.version);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('写入路由仍然只接受已登录会话', async () => {
    const { root, store, api } = setup();
    try {
      const save = createEmptySnapshot();
      save.settings.name = '应当写不进去';
      const denied = await api(new Request(`${ORIGIN}/api/snapshot`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: 'vita-log-session=made-up' },
        body: JSON.stringify({ snapshot: save, expectedVersion: 0 }),
      }));
      expect(denied.status).toBe(401);
      expect(store.load().empty).toBe(true);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });
});