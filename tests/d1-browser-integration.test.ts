/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountApp } from '../src/app';
import { D1HealthRepository } from '../src/d1-storage';
import { ServerEditorAuth } from '../src/server-auth';
import { createEmptySnapshot, type HealthSnapshot } from '../src/domain';
import { createOwnerCredential } from '../functions/_lib/owner-credentials';
import { CloudflareRuntime, resetRuntime } from './support/cloudflare-runtime';
import { SqliteD1 } from './support/sqlite-d1';

/**
 * The browser seam for the Cloudflare deployment, which is the seam the spec
 * names: the full page, driven through the health-data repository contract,
 * against the real Pages Function routes.
 *
 * What makes this more than a restatement of the client unit tests is that
 * nothing here decides authorization. The page's own repository and auth
 * classes call `fetch`; the double routes to the shipped `onRequest` exports;
 * those handlers run real SQL. A case below that expects a refusal gets it from
 * `functions/api/*`, not from a queue of responses chosen to match the
 * expectation — which is exactly the arrangement that hid a broken write path
 * in 06.1-02a, where the fake performed a `version + 1` the production UPDATE
 * never did.
 */

const OWNER = 'owner';
const PASSWORD = 'a sufficiently long owner password';
// PBKDF2 at 210,000 iterations is the expensive part of the suite. Derive the
// deployment secret once, the way ops does, rather than once per case.
const CREDENTIAL = await createOwnerCredential(PASSWORD);

/**
 * The page's clock starts at the real time on purpose.
 *
 * `ServerEditorAuth` takes its deadline from the server, which stamps sessions
 * with its own `Date.now()`. A fixed past date would leave that deadline in the
 * future relative to the injected clock, so the expiry case would advance past
 * 30 minutes and still see a live session — the assertion would then have been
 * passing or failing for reasons unrelated to expiry.
 */
const NOW = Date.now();

const ownerSnapshot = (): HealthSnapshot => {
  const snapshot = createEmptySnapshot('2026-10-06T07:00:00.000Z');
  snapshot.settings.name = '轻盈';
  snapshot.weights = [{
    id: 'w1', date: '2026-10-06', weightKg: 76.4, bodyfatPercent: 21.5, note: '晨起空腹',
    createdAt: '2026-10-06T07:00:00.000Z', updatedAt: '2026-10-06T07:00:00.000Z',
  }];
  return snapshot;
};

/** A deployment that already holds imported health data, at version 4. */
const deployed = (db = new SqliteD1()): CloudflareRuntime => {
  const runtime = new CloudflareRuntime({ db, credential: CREDENTIAL, username: OWNER });
  db.seed(JSON.stringify(ownerSnapshot()), 4);
  return runtime;
};

/** The payload D1 currently holds, decoded. */
const stored = (runtime: CloudflareRuntime): HealthSnapshot => {
  const row = runtime.db.db.prepare('SELECT payload FROM health_state WHERE id = 1').get() as { payload: string };
  return JSON.parse(row.payload) as HealthSnapshot;
};

interface Page {
  container: HTMLElement;
  clock: { value: number };
  unmount: () => void;
}

interface PageOptions {
  clock?: { value: number };
  /** Replace the transport, to model a request that fails in a specific way. */
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

const openPage = (runtime: CloudflareRuntime, options: PageOptions = {}): Page => {
  const container = document.createElement('div');
  document.body.append(container);
  const clock = options.clock ?? { value: NOW };
  const transport = options.fetch ?? runtime.fetch;
  // The clock is injected rather than faked globally so advancing time to reach
  // the session deadline cannot also move the server, which keeps its own
  // `Date.now()`. Expiry is therefore tested where the page decides it; the
  // server's own absolute expiry stays covered by the route tests.
  const unmount = mountApp(
    container,
    new D1HealthRepository({ fetch: transport }),
    new ServerEditorAuth({ fetch: transport }, () => clock.value),
    { source: 'server' },
  );
  return { container, clock, unmount };
};

/**
 * Let the page finish its current work.
 *
 * Counting turns is not sound here, and that is a property of the code under
 * test rather than of the test: logging in runs 210,000 PBKDF2 iterations,
 * which resolve on a real macrotask and take ~25ms. A dozen `setTimeout(0)`
 * turns span about a dozen milliseconds, so they returned while the login was
 * still in flight — and every assertion after that would have been testing a
 * page that had not finished authenticating, which is exactly how a real
 * "the editor never opens" defect would have been indistinguishable from a
 * slow test. So the waits below are on observable state, not on elapsed time.
 */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 8; turn += 1) await new Promise((resolve) => { setTimeout(resolve, 0); });
};

/** Wait until `ready` stops throwing, i.e. the page has reached a settled state. */
const until = async (ready: () => void, what: string): Promise<void> => {
  try { ready(); return; } catch { /* not there yet; fall through to polling */ }
  await vi.waitFor(ready, { timeout: 4_000, interval: 10 }).catch((error: unknown) => {
    throw new Error(`page never reached: ${what}\n${error instanceof Error ? error.message : String(error)}`);
  });
};

const click = async (page: Page, selector: string): Promise<void> => {
  const control = page.container.querySelector<HTMLElement>(selector);
  if (!control) throw new Error(`missing control: ${selector}`);
  control.click();
  await settle();
};

/**
 * Wait for the initial read to land, whichever way it landed.
 *
 * The predicate is "no longer loading", not "a dashboard is present": the
 * loading screen has no `.metric-grid` either, so a check for the dashboard
 * would also be satisfied by a page that has not finished reading — and the
 * fail-closed case is supposed to end on `.fatal-state` instead.
 */
const opened = (page: Page): void => {
  if (page.container.querySelector('[data-action="reload"]') === null) throw new Error('page still loading');
};

/**
 * A finished login has reached one of three terminal states: the editor is open,
 * the modal came back with an error, or the reload failed outright.
 *
 * "The modal is gone" is not one of them, and treating it as one is a race: the
 * modal closes on the first render *inside* the post-login reload, so a test
 * that waited only for its disappearance continued while the owner snapshot was
 * still being fetched. The version conflict case below then seeded the database
 * mid-reload and the save quietly succeeded against the value it picked up
 * afterwards.
 */
const loginFinished = (page: Page): void => {
  if (page.container.querySelector('#authForm .form-error')) return;
  if (page.container.querySelector('#bodyRecordForm')) return;
  if (page.container.querySelector('.fatal-state')) return;
  throw new Error('login still in flight');
};

const openEditor = async (page: Page, username = OWNER, password = PASSWORD): Promise<void> => {
  await click(page, '[data-action="auth-toggle"]');
  await until(() => { if (!page.container.querySelector('#authForm')) throw new Error('auth modal not open'); }, 'the auth modal');
  const form = page.container.querySelector<HTMLFormElement>('#authForm')!;
  form.querySelector<HTMLInputElement>('input[name="username"]')!.value = username;
  form.querySelector<HTMLInputElement>('input[name="password"]')!.value = password;
  form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
  await until(() => loginFinished(page), 'the login to finish');
};

/**
 * A save is done when it has either been refused (an error is on screen) or
 * accepted (the form was reset for the next entry).
 *
 * The presence of the body form is not a completion signal: the editor stays
 * open after a successful save, because the owner normally enters several
 * records in a row. Waiting for the form to disappear would have hung here
 * while the save was in fact succeeding.
 */
const saveFinished = (page: Page): void => {
  if (page.container.querySelector('.form-error[role="alert"]')) return;
  const weight = page.container.querySelector<HTMLInputElement>('#bodyRecordForm input[name="weightKg"]');
  if (weight && weight.value !== '') throw new Error('save still in flight');
};

/**
 * Add a weight on a date the fixture has no record for.
 *
 * The date is not the fixture's: `saveBodyRecords` refuses a second weight on
 * an existing date and tells the owner to edit that record instead, so reusing
 * it would have exercised the duplicate guard instead of the save path.
 */
const saveWeight = async (page: Page, weightKg: string, date = '2026-10-07'): Promise<void> => {
  const form = page.container.querySelector<HTMLFormElement>('#bodyRecordForm');
  if (!form) throw new Error('body form missing — the editor is not open');
  form.querySelector<HTMLInputElement>('input[name="date"]')!.value = date;
  form.querySelector<HTMLInputElement>('input[name="weightKg"]')!.value = weightKg;
  form.querySelector<HTMLInputElement>('input[name="bodyfatPercent"]')!.value = '';
  form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
  await until(() => saveFinished(page), 'the save to finish');
};

/** Every control on the page that could attempt a write. */
const WRITE_CONTROLS = [
  '#bodyRecordForm', '#stepForm', '#dietForm', '#settingsForm',
  '[data-action="delete-weight"]', '[data-action="delete-step"]', '[data-action="delete-diet"]',
  '[data-action="clear-all"]', '[data-action="commit-transfer"]', '[data-action="restore-recovery"]',
  '[data-action="publish"]', '[data-action="migrate-sqlite"]', '[data-action="backup-sqlite"]',
  '[data-action="restore-sqlite"]', '#transferFile',
];

const renderedWriteControls = (page: Page): string[] =>
  WRITE_CONTROLS.filter((selector) => page.container.querySelector(selector) !== null);

beforeEach(() => { resetRuntime(); document.body.innerHTML = ''; });
afterEach(() => { vi.useRealTimers(); resetRuntime(); });

describe('Cloudflare 模式：访客匿名读取', () => {
  it('访客不登录即可看到完整看板和最新已保存数据', async () => {
    const runtime = deployed();
    const page = openPage(runtime);
    await until(() => opened(page), 'the initial read');

    expect(page.container.textContent).toContain('轻盈，今天也稳稳向前。');
    expect(page.container.textContent).toContain('76.4');
    expect(page.container.textContent).toContain('只读 · 访客');
    // The page has to say where the data lives. A visitor reading "数据只保存在
    // 当前浏览器" would conclude their reading of someone else's health record
    // lives in their own browser, and would have no idea that a reload can
    // change it.
    expect(page.container.textContent).toContain('数据保存在服务端，本页只读取');
    expect(page.container.textContent).not.toContain('数据只保存在当前浏览器');
    // The read came from D1 via the anonymous public projection. The owner
    // route is probed first and answers 401 without a session — which is why
    // this assertion is about the pair, not about either route alone.
    expect(runtime.requests).toEqual(['GET /api/owner-snapshot', 'GET /api/snapshot']);
    runtime.close();
  });

  it('访客看不到任何写入口，服务端一次写请求也没有收到', async () => {
    const runtime = deployed();
    const page = openPage(runtime);
    await until(() => opened(page), 'the initial read');

    expect(renderedWriteControls(page)).toEqual([]);
    expect(page.container.querySelectorAll('form')).toHaveLength(0);
    expect(runtime.requests.filter((entry) => !entry.startsWith('GET'))).toEqual([]);
    runtime.close();
  });
});

describe('Cloudflare 模式：本人登录后编辑', () => {
  it('登录后重载完整编辑快照，保存成功且页面数据更新', async () => {
    const runtime = deployed();
    const page = openPage(runtime);
    await until(() => opened(page), 'the initial read');
    await openEditor(page);

    // Unlocking is not what grants editability. The page was holding the
    // anonymous projection, which carries no version and omits owner-only
    // settings, so it reloads through the now-authorized owner route first.
    // Without that reload the first save would be refused for having no
    // version to write against.
    expect(runtime.requests).toContain('GET /api/owner-snapshot');
    expect(page.container.querySelector('#bodyRecordForm')).not.toBeNull();
    expect(page.container.textContent).toContain('本人编辑');

    await saveWeight(page, '75.1');

    expect(page.container.textContent).toContain('已保存');
    // The dashboard shows the new edit alongside the record it was added to,
    // and the earlier one is not silently overwritten.
    expect(page.container.textContent).toContain('75.1');
    expect(page.container.textContent).toContain('76.4');
    // And D1 advanced, so a visitor reads the new value next.
    expect(runtime.db.storedVersion()).toBe(5);
    expect(stored(runtime).weights.map((record) => record.weightKg)).toEqual([76.4, 75.1]);
    runtime.close();
  });

  it('访客刷新后读到本人刚保存的快照', async () => {
    const owner = deployed();
    const ownerPage = openPage(owner);
    await until(() => opened(ownerPage), 'the initial read');
    await openEditor(ownerPage);
    await saveWeight(ownerPage, '74.6');
    expect(owner.db.storedVersion()).toBe(5);

    // A second browser sharing only the database — what a visitor refreshing
    // the page is. It holds no session, so it can only read the public route.
    const visitor = new CloudflareRuntime({ db: owner.db, credential: CREDENTIAL, username: OWNER, ip: '198.51.100.7' });
    const visitorPage = openPage(visitor);
    await until(() => opened(visitorPage), 'the visitor read');

    expect(visitorPage.container.textContent).toContain('74.6');
    expect(visitorPage.container.textContent).toContain('轻盈');
    expect(visitor.requests).toEqual(['GET /api/owner-snapshot', 'GET /api/snapshot']);
    owner.close();
  });

  it('错误密码保持只读，且没有发出任何写请求', async () => {
    const runtime = deployed();
    const page = openPage(runtime);
    await until(() => opened(page), 'the initial read');
    await openEditor(page, OWNER, 'not the owner password');

    expect(page.container.textContent).toContain('账号或密码错误');
    expect(page.container.querySelector('#bodyRecordForm')).toBeNull();
    expect(renderedWriteControls(page)).toEqual([]);
    expect(runtime.db.storedVersion()).toBe(4);
    runtime.close();
  });
});

describe('Cloudflare 模式：锁定', () => {
  it('锁定等服务端确认撤销后才变只读，撤销确实发生在服务端', async () => {
    const runtime = deployed();
    const page = openPage(runtime);
    await until(() => opened(page), 'the initial read');
    await openEditor(page);
    expect(runtime.db.sessionRows()).toBe(1);

    await click(page, '[data-action="auth-toggle"]');
    // The page only re-renders once `lock()` has come back, so waiting for the
    // read-only state is also waiting for the logout to have been dispatched.
    await until(() => {
      if (page.container.querySelector('#bodyRecordForm')) throw new Error('still editing');
    }, 'the page to return to read-only');

    expect(renderedWriteControls(page)).toEqual([]);
    expect(runtime.requests).toContain('POST /api/logout');
    expect(runtime.db.sessionRows(), '撤销必须发生在服务端，而不只是页面上藏起控件').toBe(0);
    runtime.close();
  });

  it('注销请求失败时不谎报已锁定：控件仍在，服务端会话也仍有效', async () => {
    const runtime = deployed();
    // Break only the logout call, after a real session exists. A page that hid
    // its controls here would be telling the owner they are safe while their
    // session still writes for the rest of its 30 minutes.
    //
    // The attempt is recorded here rather than on the runtime, because a
    // request the double refuses never reaches the routing it would normally
    // be counted by.
    let logoutAttempted = false;
    const logoutFails = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(input) === '/api/logout') {
        logoutAttempted = true;
        return new Response(JSON.stringify({ code: 'database-unavailable', message: '健康数据服务暂时不可用，请稍后重试' }), { status: 503 });
      }
      return runtime.fetch(input, init);
    };

    const page = openPage(runtime, { fetch: logoutFails });
    await until(() => opened(page), 'the initial read');
    await openEditor(page);
    expect(runtime.db.sessionRows()).toBe(1);

    await click(page, '[data-action="auth-toggle"]');
    await until(() => { if (!logoutAttempted) throw new Error('logout not attempted yet'); }, 'the logout to be attempted');

    expect(page.container.textContent).toContain('本人编辑');
    expect(page.container.querySelector('#bodyRecordForm'), '会话仍有效时页面不得显示为已锁定').not.toBeNull();
    expect(runtime.db.sessionRows()).toBe(1);
    runtime.close();
  });
});

describe('Cloudflare 模式：会话到期', () => {
  it('过了 30 分钟绝对期限后页面恢复只读，隐藏全部写入口', async () => {
    const runtime = deployed();
    // Only the interval is faked — the one timer that decides read-only — while
    // `setTimeout` stays real so the waits above still work. Faking every timer
    // would have frozen the clock during login, and PBKDF2 runs on a real
    // macrotask: the login would never finish and the case would have failed
    // for a reason that has nothing to do with expiry.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const clock = { value: NOW };
    const page = openPage(runtime, { clock });
    await until(() => opened(page), 'the initial read');
    await openEditor(page);
    expect(page.container.querySelector('#bodyRecordForm')).not.toBeNull();

    clock.value = NOW + 31 * 60 * 1000;
    await vi.advanceTimersByTimeAsync(1_500);
    await settle();

    expect(page.container.querySelector('#bodyRecordForm')).toBeNull();
    expect(renderedWriteControls(page)).toEqual([]);
    expect(page.container.textContent).toContain('只读 · 访客');
    vi.useRealTimers();
    runtime.close();
  });
});

describe('Cloudflare 模式：故障 fail-closed', () => {
  it('D1 不可用时报服务不可用，不显示空看板，也不让访客去修本地存储', async () => {
    // Every statement throws, the way an unreachable binding behaves.
    const dead = new CloudflareRuntime({ db: new SqliteD1({ error: new Error('D1 is unreachable') }), credential: CREDENTIAL, username: OWNER });
    const page = openPage(dead);
    await until(() => opened(page), 'the failed read');

    expect(page.container.textContent).toContain('健康数据服务暂时不可用');
    // A visitor must never read an outage as "no records yet".
    expect(page.container.querySelector('.metric-grid')).toBeNull();
    expect(page.container.textContent).not.toContain('还没有记录');
    // Nor may the wording send them to fix browser storage: the store is the
    // server's, and telling a visitor to clear their browser would be a
    // repair step that cannot possibly help.
    expect(page.container.textContent).not.toContain('本地存储');
    expect(page.container.textContent).not.toContain('本地数据');
    dead.close();
  });
});

describe('Cloudflare 模式：服务端错误码语义', () => {
  it('版本冲突时页面显示服务端原文，而不是通用的「保存失败」', async () => {
    const runtime = deployed();
    const page = openPage(runtime);
    await until(() => opened(page), 'the initial read');
    await openEditor(page);

    // Another tab saves first, so this page's version is stale. The message the
    // owner reads has to be the server's — "reload, your input is preserved" —
    // because a generic "save failed" would send them to re-enter the record
    // they have not lost.
    runtime.db.seed(JSON.stringify(ownerSnapshot()), 9);
    await saveWeight(page, '75.1');

    expect(page.container.textContent).toContain('数据已更新，请重新加载；未提交输入已保留');
    expect(page.container.textContent).not.toContain('健康数据保存失败');
    // The rejected write must not have been applied.
    expect(runtime.db.storedVersion()).toBe(9);
  });

  it('会话在编辑中途被服务端撤销后，页面停止提供编辑入口', async () => {
    const runtime = deployed();
    const page = openPage(runtime);
    await until(() => opened(page), 'the initial read');
    await openEditor(page);
    expect(page.container.querySelector('#bodyRecordForm')).not.toBeNull();

    // The owner locks from another device. This page's own clock has not run
    // out, so without the server's answer it would keep showing an editor whose
    // every save is about to be refused.
    runtime.db.db.exec('DELETE FROM owner_session');
    await saveWeight(page, '75.1');

    expect(page.container.textContent).toContain('编辑会话已失效');
    expect(page.container.querySelector('#bodyRecordForm'), '会话已被服务端撤销，页面不得继续显示编辑入口').toBeNull();
    expect(renderedWriteControls(page)).toEqual([]);
  });
});

describe('Cloudflare 模式：绕过页面直接调用 API', () => {
  it('匿名直接 PUT 被服务端拒绝，D1 数据不变', async () => {
    const runtime = deployed();

    // What a tampered page or a replayed request would do: skip every control
    // and call the write route itself.
    const response = await runtime.fetch('/api/snapshot', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snapshot: ownerSnapshot(), expectedVersion: 4 }),
    });

    expect(response.status).toBe(401);
    expect((await response.json() as { code: string }).code).toBe('unauthorized');
    expect(runtime.db.storedVersion()).toBe(4);
    expect(runtime.db.storedName()).toBe('轻盈');
    runtime.close();
  });

  it('未登录读不到 owner 快照，公开投影不含内部存储字段', async () => {
    const runtime = deployed();

    const owner = await runtime.fetch('/api/owner-snapshot', { credentials: 'same-origin' });
    expect(owner.status).toBe(401);

    const publicProjection = await (await runtime.fetch('/api/snapshot', { credentials: 'same-origin' })).json() as Record<string, unknown>;
    expect(publicProjection).not.toHaveProperty('version');
    expect(publicProjection).not.toHaveProperty('saved_at');
    runtime.close();
  });

  it('匿名调用迁移与迁移预览同样被拒绝', async () => {
    // Migration and its preview are named alongside the other write paths in
    // this ticket's acceptance list, so "hidden in the page" is not the bar —
    // the route has to refuse an anonymous caller.
    const runtime = deployed();
    const body = JSON.stringify({ snapshot: ownerSnapshot(), expectedVersion: 4 });

    for (const path of ['/api/migrate', '/api/migration-preview']) {
      const response = await runtime.fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(response.status, `${path} 匿名调用应当被拒绝`).toBe(401);
      expect((await response.json() as { code: string }).code).toBe('unauthorized');
    }
    expect(runtime.db.storedVersion()).toBe(4);
    runtime.close();
  });
});
