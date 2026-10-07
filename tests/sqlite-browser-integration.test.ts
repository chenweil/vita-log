/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes, scryptSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountApp } from '../src/app';
import { SqliteHealthRepository } from '../src/sqlite-storage';
import { ServerEditorAuth } from '../src/server-auth';
import { createApi } from '../server/api';
import { SqliteStore } from '../server/store';

/**
 * The self-hosted backend, driven the way the browser drives it.
 *
 * `createApi` takes a `Request` and answers a `Response`, so it can be the
 * transport directly — no queued responses, nothing that gets to decide which
 * failure the page should be shown. The only thing modelled here is what a
 * browser adds: a cookie jar and the `Origin` on a write, which this server
 * checks.
 *
 * The D1 suite covers the same four outcomes against the Pages Functions. This
 * file exists because a classification that only ever ran against one backend
 * is a classification against a backend, not against a contract.
 */

const OWNER = 'owner';
const PASSWORD = 'a sufficiently long owner password';
const ORIGIN = 'http://127.0.0.1';
const NOW = Date.now();

interface Backend {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  store: SqliteStore;
  /** Take the database away under the page, the way a failed disk would. */
  closeStore: () => void;
  dispose: () => void;
}

const backend = (options: { dropLogin?: boolean } = {}): Backend => {
  const root = mkdtempSync(join(tmpdir(), 'vita-browser-'));
  const store = new SqliteStore({ database: join(root, 'data.sqlite'), backups: join(root, 'backups') });
  const salt = randomBytes(16).toString('hex');
  store.setOwnerCredentials(OWNER, salt, scryptSync(PASSWORD, salt, 64).toString('hex'));
  const api = createApi(store, () => NOW);
  let cookie = '';
  // The server's own cookie name, named once. A `set-cookie` this cannot read
  // used to be swallowed into an empty jar, which silently logged the test out
  // instead of failing — a renamed cookie would have cost one whole suite.
  const sessionCookie = /^vita-log-session=([^;]*)/;
  const dispose = (): void => { try { store.close(); } catch { /* already closed by the test */ } rmSync(root, { recursive: true, force: true }); };

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (options.dropLogin && String(input) === '/api/login') throw new Error('connection reset');
    const request = new Request(new URL(String(input), ORIGIN), init);
    const headers = new Headers(request.headers);
    // The server refuses a write without these, and it is right to: they are
    // part of the authorization contract, not decoration.
    if (request.method !== 'GET') headers.set('origin', ORIGIN);
    if (cookie) headers.set('cookie', cookie);
    const body = request.method === 'GET' ? undefined : await request.text();
    const response = await api(new Request(request.url, { method: request.method, headers, ...(body === undefined ? {} : { body }) }));
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const value = sessionCookie.exec(setCookie)?.[1];
      if (value === undefined) throw new Error(`unrecognised set-cookie: ${setCookie}`);
      cookie = value ? `vita-log-session=${value}` : '';
    }
    return response;
  };

  return { fetch, store, closeStore: () => store.close(), dispose };
};

/**
 * Wait for an observable state, not for a number of turns.
 *
 * The sibling D1 suite says the same thing and has the reason: counting turns
 * is a guess about how many microtasks a round trip took, and a guess that
 * fails slowly.
 */
const until = async (ready: () => void, what: string): Promise<void> => {
  try { ready(); return; } catch { /* not there yet; fall through to polling */ }
  await vi.waitFor(ready, { timeout: 4_000, interval: 10 }).catch((error: unknown) => {
    throw new Error(`page never reached: ${what}\n${error instanceof Error ? error.message : String(error)}`);
  });
};

/** The dashboard is on screen — or the fatal-state screen, which has its own reload. */
const opened = (container: HTMLElement): void => {
  if (!container.querySelector('[data-action="reload"]')) throw new Error('page still loading');
};

/** A submitted login has come to rest: refused in the modal, or open in the editor. */
const loginSettled = (container: HTMLElement): void => {
  if (container.querySelector('#authForm .form-error')) return;
  if (container.querySelector('#bodyRecordForm')) return;
  throw new Error('the login is still in flight');
};

const openPage = (host: Backend): { container: HTMLElement; dispose: () => void } => {
  const container = document.createElement('div');
  document.body.append(container);
  const unmount = mountApp(container, new SqliteHealthRepository({ fetch: host.fetch }), new ServerEditorAuth({ fetch: host.fetch }, () => NOW));
  return { container, dispose: () => { unmount(); container.remove(); } };
};

const submitLogin = async (container: HTMLElement, password: string): Promise<void> => {
  const toggle = container.querySelector<HTMLElement>('[data-action="auth-toggle"]');
  if (!toggle) throw new Error('the auth control is missing');
  toggle.click();
  await until(() => { if (!container.querySelector('#authForm')) throw new Error('the auth modal did not open'); }, 'the auth modal');
  const form = container.querySelector<HTMLFormElement>('#authForm')!;
  form.querySelector<HTMLInputElement>('input[name="username"]')!.value = OWNER;
  form.querySelector<HTMLInputElement>('input[name="password"]')!.value = password;
  form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
  await until(() => loginSettled(container), 'the login to settle');
};

afterEach(() => { document.body.innerHTML = ''; });

describe('SQLite 模式：登录失败的四类语义', () => {
  it('凭据被拒时提示服务端原文，不牵连服务状态', async () => {
    const host = backend();
    const page = openPage(host);
    try {
      await until(() => opened(page.container), 'the initial read');
      await submitLogin(page.container, 'not the owner password');

      expect(page.container.textContent).toContain('账号或密码错误');
      expect(page.container.querySelector('#bodyRecordForm')).toBeNull();
    } finally { page.dispose(); host.dispose(); }
  });

  it('被限流时提示稍后重试，而不是让本人去改密码', async () => {
    const host = backend();
    const page = openPage(host);
    try {
      await until(() => opened(page.container), 'the initial read');
      // This server counts attempts in memory and answers the eleventh with
      // 429 — carrying the same `code` as a wrong password.
      for (let attempt = 0; attempt < 11; attempt += 1) {
        await host.fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ username: OWNER, password: 'not the owner password' }) });
      }
      await submitLogin(page.container, PASSWORD);

      expect(page.container.textContent).toContain('请一分钟后重试');
      expect(page.container.textContent, '限流不是密码问题').not.toContain('账号或密码错误');
      expect(page.container.querySelector('#bodyRecordForm')).toBeNull();
    } finally { page.dispose(); host.dispose(); }
  });

  it('数据库在登录时不可用时，不得说成密码错误', async () => {
    const host = backend();
    const page = openPage(host);
    try {
      await until(() => opened(page.container), 'the initial read');
      // The credentials live in the same database, so taking it away turns a
      // correct login into a 503 — the exact case the boolean contract used to
      // report as a typo.
      host.closeStore();
      await submitLogin(page.container, PASSWORD);

      expect(page.container.textContent).toContain('不可用');
      expect(page.container.textContent, '服务故障时不得指责密码').not.toContain('账号或密码错误');
      expect(page.container.querySelector('#bodyRecordForm')).toBeNull();
    } finally { page.dispose(); host.dispose(); }
  });

  it('登录请求本身断了时，不把网络故障说成密码错误', async () => {
    const host = backend({ dropLogin: true });
    const page = openPage(host);
    try {
      await until(() => opened(page.container), 'the initial read');
      await submitLogin(page.container, PASSWORD);

      expect(page.container.textContent).not.toContain('账号或密码错误');
      expect(page.container.textContent).toContain('重试');
      expect(page.container.querySelector('#bodyRecordForm')).toBeNull();
    } finally { page.dispose(); host.dispose(); }
  });
});
