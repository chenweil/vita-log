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

/**
 * The snapshot D1 holds, with the owner's own theme colour on it.
 *
 * `primaryColor` is deliberately owner-only: it is absent from the public
 * projection, which rebuilds it from the defaults. It is therefore the field
 * that shows *which* snapshot a save wrote back — the owner's, or the one a
 * visitor can see.
 */
const ownerOnlySnapshot = (): HealthSnapshot => {
  const snapshot = ownerSnapshot();
  snapshot.settings.primaryColor = '#123456';
  return snapshot;
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

/** The status the page shows while a read is in flight. */
const READING = '正在读取服务端最新数据';

/**
 * A finished login has reached one of four terminal states: the editor is open,
 * the modal came back with an error, the reload failed outright, or the reload
 * came back without the complete snapshot the editor needs.
 *
 * Neither "the modal is gone" nor "the editor appeared" is one of them, and
 * treating either as one is a race: the modal closes on the first render
 * *inside* the post-login reload, so a test that waited only for its
 * disappearance continued while the owner snapshot was still being fetched. The
 * version conflict case below then seeded the database mid-reload and the save
 * quietly succeeded against the value it picked up afterwards. The read has to
 * be waited out — but not for a particular outcome, or a login that correctly
 * ends in read-only would look like one that never finished.
 */
const loginFinished = (page: Page): void => {
  const container = page.container;
  if (container.querySelector('#authForm .form-error')) return;
  if (container.querySelector('.fatal-state')) return;
  if (container.querySelector('#authForm')) throw new Error('the login has not been submitted yet');
  if (container.textContent?.includes(READING)) throw new Error('the owner reload is still in flight');
};

/**
 * Make "the page has taken this response in" observable.
 *
 * A superseded read changes nothing on screen, so the transport is the only
 * place left that can say whether the page processed it. `setTimeout` runs
 * after the page's `await response.json()` continuation, so the flag reads as
 * "the page is done with this response", not "the server answered". Counting
 * turns instead would be a guess at how many microtasks the handler took.
 */
const observedAfter = (response: Response, property: 'json' | 'text', onConsumed: () => void): Response =>
  new Proxy(response, {
    get(target, key, receiver) {
      if (key === property) return async () => {
        const value = await (target[property]() as Promise<unknown>);
        setTimeout(onConsumed, 0);
        return value;
      };
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Response;

/** Fill and submit the login form without waiting for the round trip. */
const submitLogin = (page: Page, username = OWNER, password = PASSWORD): void => {
  const form = page.container.querySelector<HTMLFormElement>('#authForm');
  if (!form) throw new Error('auth modal not open');
  form.querySelector<HTMLInputElement>('input[name="username"]')!.value = username;
  form.querySelector<HTMLInputElement>('input[name="password"]')!.value = password;
  form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
};

const openEditor = async (page: Page, username = OWNER, password = PASSWORD): Promise<void> => {
  await click(page, '[data-action="auth-toggle"]');
  await until(() => { if (!page.container.querySelector('#authForm')) throw new Error('auth modal not open'); }, 'the auth modal');
  submitLogin(page, username, password);
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

/** Cases below stub the confirmation dialog; give the next one a clean one. */
const browserConfirm = window.confirm;

beforeEach(() => { resetRuntime(); document.body.innerHTML = ''; });
afterEach(() => { vi.useRealTimers(); resetRuntime(); window.confirm = browserConfirm; });

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

/**
 * Editing is a property of the snapshot on screen, not of the session alone.
 *
 * The page may hold an owner snapshot or the anonymous public projection, and
 * only the first can be saved: the projection carries no version and omits
 * owner-only settings, so writing it back would quietly reset them. These cases
 * are about the three ways the page can end up holding the projection while a
 * session appears to be live.
 */
describe('Cloudflare 模式：编辑能力只来自完整 owner 快照', () => {
  it('重新登录的重载期间不渲染编辑器，即使页面还留着上一次的 owner 快照', async () => {
    const runtime = deployed();
    let parkNextOwnerRead = false;
    let ownerReadParked = false;
    let releaseOwner: () => void = () => {};
    const ownerReadPending = new Promise<void>((resolve) => { releaseOwner = resolve; });
    const parkOwnerRead = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const isOwnerRead = (init?.method ?? 'GET') === 'GET' && String(input) === '/api/owner-snapshot';
      if (!isOwnerRead || !parkNextOwnerRead) return runtime.fetch(input, init);
      parkNextOwnerRead = false;
      const response = await runtime.fetch(input, init);
      ownerReadParked = true;
      await ownerReadPending;
      return response;
    };

    const page = openPage(runtime, { fetch: parkOwnerRead });
    await until(() => opened(page), 'the initial read');
    await openEditor(page);
    await click(page, '[data-action="auth-toggle"]');
    await until(() => { if (page.container.querySelector('#bodyRecordForm')) throw new Error('still editing'); }, 'the page to return to read-only');

    // Log in again. The page still holds the owner snapshot it read before the
    // lock, so nothing about the data in hand says "not editable" — only the
    // reload in progress does. That is the whole point of suppressing the
    // editor here: an editor over it would offer a save against a version the
    // repository has already discarded.
    parkNextOwnerRead = true;
    await click(page, '[data-action="auth-toggle"]');
    await until(() => { if (!page.container.querySelector('#authForm')) throw new Error('auth modal not open'); }, 'the auth modal');
    submitLogin(page);
    await until(() => {
      if (!ownerReadParked) throw new Error('the owner reload has not reached the owner route');
      if (!page.container.textContent?.includes(READING)) throw new Error('the page has not entered the reload yet');
    }, 'the owner reload to be in flight');

    expect(page.container.querySelector('#bodyRecordForm'), '重载完成前不得渲染编辑器').toBeNull();
    expect(renderedWriteControls(page)).toEqual([]);

    releaseOwner();
    await until(() => { if (!page.container.querySelector('#bodyRecordForm')) throw new Error('the editor is not open yet'); }, 'the editor to open after the reload');

    // The reload is what granted editability, and it re-read the server rather
    // than reusing what was on screen.
    expect(runtime.db.storedVersion()).toBe(4);
    expect(page.container.textContent).toContain('本人编辑');
    runtime.close();
  });

  it('过期的 owner 读取不得改写仓库版本：下一次保存必须被版本冲突挡住', async () => {
    const runtime = deployed();
    let parkNextOwnerRead = false;
    let parked = false;
    let lateReadConsumed = false;
    let releaseRead: () => void = () => {};
    const readPending = new Promise<void>((resolve) => { releaseRead = resolve; });
    // Park the read *before* it reaches the server, so it observes whatever D1
    // holds by the time it finally runs. A request dispatched earlier can
    // perfectly well observe newer server state than one dispatched after it —
    // and that is what makes a late owner read dangerous rather than merely
    // redundant.
    const parkOwnerRead = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const isOwnerRead = (init?.method ?? 'GET') === 'GET' && String(input) === '/api/owner-snapshot';
      if (isOwnerRead && parkNextOwnerRead) {
        parkNextOwnerRead = false;
        parked = true;
        await readPending;
        return observedAfter(await runtime.fetch(input, init), 'json', () => { lateReadConsumed = true; });
      }
      return runtime.fetch(input, init);
    };

    const page = openPage(runtime, { fetch: parkOwnerRead });
    await until(() => opened(page), 'the initial read');
    await openEditor(page);
    expect(runtime.db.storedVersion()).toBe(4);

    parkNextOwnerRead = true;
    await click(page, '[data-action="reload"]');
    await until(() => { if (!parked) throw new Error('the first refresh has not parked'); }, 'the first refresh to park');
    await click(page, '[data-action="reload"]');
    await until(() => {
      if (page.container.textContent?.includes(READING)) throw new Error('the second refresh is still in flight');
    }, 'the second refresh to land');

    // Another tab saves while the parked read is still open.
    const other = ownerOnlySnapshot();
    other.weights.push({ id: 'w2', date: '2026-10-08', weightKg: 73.9, note: '另一客户端', createdAt: '2026-10-08T08:00:00.000Z', updatedAt: '2026-10-08T08:00:00.000Z' });
    runtime.db.seed(JSON.stringify(other), 5);

    releaseRead();
    await until(() => { if (!lateReadConsumed) throw new Error('the parked read has not been taken in'); }, 'the parked read to land');

    // The page still holds v4. The danger is not the discarded snapshot — it is
    // the repository quietly adopting that read's v5: the next save would then
    // be accepted against v5 and write v6 built from v4 content, overwriting
    // what the other tab just saved, with no conflict and no error.
    await saveWeight(page, '75.1');

    expect(runtime.db.storedVersion(), '过期读取不得让保存越过版本冲突').toBe(5);
    expect(stored(runtime).weights.map((record) => record.weightKg)).toEqual([76.4, 73.9]);
    expect(page.container.textContent).toContain('数据已更新，请重新加载');
    runtime.close();
  });

  it('旧的公共响应晚到时，不得覆盖已登录的 owner 快照并把它保存回去', async () => {
    const runtime = deployed();
    runtime.db.seed(JSON.stringify(ownerOnlySnapshot()), 4);

    let releasePublic: () => void = () => {};
    const publicReadPending = new Promise<void>((resolve) => { releasePublic = resolve; });
    let publicReads = 0;
    let staleReadConsumed = false;
    // Only the *second* public read is parked, so the page finishes its initial
    // read and reaches a state where the owner can start a refresh. The server
    // still answers that refresh; what is held back is handing the answer to
    // the page, which is what lets the refresh land after the login reload.
    const delayRefresh = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const stale = (init?.method ?? 'GET') === 'GET' && String(input) === '/api/snapshot' && ++publicReads === 2;
      const response = await runtime.fetch(input, init);
      if (!stale) return response;
      await publicReadPending;
      // `setTimeout` runs after the page's `await response.text()` continuation,
      // so the flag means "the page has taken this response in", not "the server
      // has answered it". Counting turns instead would be a guess about how many
      // microtasks the handler took.
      return observedAfter(response, 'text', () => { staleReadConsumed = true; });
    };

    const page = openPage(runtime, { fetch: delayRefresh });
    await until(() => opened(page), 'the initial read');

    // The owner refreshes, and logs in while that refresh is still open. Both
    // are ordinary things to do, and the page supports both controls at once.
    await click(page, '[data-action="reload"]');
    await until(() => { if (publicReads !== 2) throw new Error('the refresh has not reached the public route'); }, 'the refresh to reach the public route');
    await openEditor(page);
    expect(page.container.querySelector('#bodyRecordForm')).not.toBeNull();

    // The anonymous projection now arrives, an answer the page asked for before
    // it knew there was an owner session.
    releasePublic();
    await until(() => { if (!staleReadConsumed) throw new Error('the stale public read has not been consumed'); }, 'the stale public read to land');

    expect(page.container.querySelector('#bodyRecordForm'), '过期的公共响应不得把已登录的编辑态换成只读投影').not.toBeNull();
    await saveWeight(page, '75.1');

    expect(runtime.db.storedVersion()).toBe(5);
    expect(stored(runtime).weights.map((record) => record.weightKg)).toEqual([76.4, 75.1]);
    // The save wrote back the owner's snapshot. Had the page kept the visitor's
    // projection, the write would have succeeded and reset every owner-only
    // setting to its default — a 200 that quietly destroys data.
    expect(stored(runtime).settings.primaryColor, '保存必须写回 owner 快照，而不是访客看得到的公共投影').toBe('#123456');
    runtime.close();
  });

  it('登录成功但服务端不返回完整 owner 快照时，页面保持只读并说明原因', async () => {
    const runtime = deployed();
    // The session is revoked in the instant between the login succeeding and the
    // reload that login is supposed to authorize — the owner locking from
    // another device, or the server dropping the row. The page's own clock has
    // not run out, so nothing about its state tells it to distrust the read.
    const revokeOnLogin = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const response = await runtime.fetch(input, init);
      if (String(input) === '/api/login' && response.ok) runtime.db.db.exec('DELETE FROM owner_session');
      return response;
    };

    const page = openPage(runtime, { fetch: revokeOnLogin });
    await until(() => opened(page), 'the initial read');
    await openEditor(page);

    // The owner route was asked for and refused, so the read fell back to the
    // anonymous projection. Unlocking is not what grants editability; a
    // successful login is not evidence that the owner snapshot arrived.
    expect(runtime.requests).toContain('GET /api/owner-snapshot');
    expect(page.container.querySelector('#bodyRecordForm')).toBeNull();
    expect(renderedWriteControls(page)).toEqual([]);
    // Silence would leave the owner looking for a login box that will never
    // appear again.
    expect(page.container.textContent).toContain('服务端没有返回完整编辑快照');
    expect(runtime.db.storedVersion()).toBe(4);
    runtime.close();
  });

  it('编辑中途会话被撤销后刷新，编辑器关闭且不再提供写入口', async () => {
    const runtime = deployed();
    const page = openPage(runtime);
    await until(() => opened(page), 'the initial read');
    await openEditor(page);
    expect(page.container.querySelector('#bodyRecordForm')).not.toBeNull();

    runtime.db.db.exec('DELETE FROM owner_session');
    await click(page, '[data-action="reload"]');
    await until(() => { if (page.container.querySelector('#bodyRecordForm')) throw new Error('still editing'); }, 'the editor to close');

    // The refresh fell back to the projection. A live-looking session is not a
    // reason to keep an editor whose saves the server would refuse.
    expect(renderedWriteControls(page)).toEqual([]);
    expect(page.container.textContent).toContain('服务端没有返回完整编辑快照');
    expect(runtime.db.storedVersion()).toBe(4);
    runtime.close();
  });
});

describe('Cloudflare 模式：恢复点', () => {
  it('D1 保存后不谎称有恢复点：恢复按钮保持禁用', async () => {
    const runtime = deployed();
    const page = openPage(runtime);
    await until(() => opened(page), 'the initial read');
    await openEditor(page);
    await saveWeight(page, '75.1');
    expect(runtime.db.storedVersion()).toBe(5);

    // D1 has no recovery endpoint in this deployment, so this save could not
    // have left anything to restore. Enabling the button would promise a way
    // back that fails at the exact moment the owner needs it — and "已清空全部
    // 记录，可从恢复点还原" would be a promise with nothing behind it.
    const button = page.container.querySelector<HTMLButtonElement>('[data-action="restore-recovery"]');
    expect(button, '在线模式的恢复按钮仍然渲染，只是保持禁用').not.toBeNull();
    expect(button?.disabled).toBe(true);
    expect(page.container.textContent).toContain('暂无恢复快照');
    runtime.close();
  });

  it('D1 清空前后都不承诺恢复点：确认框与结果文案都要按能力说话', async () => {
    const runtime = deployed();
    const page = openPage(runtime);
    await until(() => opened(page), 'the initial read');
    await openEditor(page);

    const asked: string[] = [];
    window.confirm = (message?: string) => { asked.push(String(message ?? '')); return true; };

    await click(page, '[data-action="clear-all"]');
    await until(() => {
      if (!page.container.querySelector('.form-error[role="alert"]')) throw new Error('the clear has not reported back');
    }, 'the clear result');

    // "当前数据会先保存到恢复点" and "可从恢复点还原" are both promises about a
    // capability this deployment does not have. The second one is read moments
    // after the records are gone, which is exactly when the owner is most
    // likely to believe it.
    expect(asked[0], '清空前的确认框不能承诺一个 D1 留不下的恢复点').not.toContain('恢复点');
    expect(page.container.textContent, '清空后的结果不能承诺可从恢复点还原').not.toContain('恢复点还原');
    // And the honest alternative has to be there: exporting is the only way back.
    expect(page.container.textContent).toContain('如需保留请先导出完整 JSON');
    expect(runtime.db.storedVersion()).toBe(5);
    expect(stored(runtime).weights).toEqual([]);
    runtime.close();
  });

  it('D1 导入确认不承诺恢复点', async () => {
    const runtime = deployed();
    const page = openPage(runtime);
    await until(() => opened(page), 'the initial read');
    await openEditor(page);

    const asked: string[] = [];
    window.confirm = (message?: string) => { asked.push(String(message ?? '')); return true; };
    const input = page.container.querySelector<HTMLInputElement>('#transferFile');
    if (!input) throw new Error('the import control is missing');
    const contents = JSON.stringify(ownerOnlySnapshot());
    const backup = new File([contents], 'backup.json', { type: 'application/json' });
    // This jsdom ships no `Blob.text()`, which every browser has had for years
    // and which `previewTransferFile` relies on. Supply that one method so the
    // page's own import path runs — rather than reworking it for a gap in the
    // test environment.
    Object.defineProperty(backup, 'text', { value: async () => contents, configurable: true });
    Object.defineProperty(input, 'files', { value: [backup], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => { if (!page.container.querySelector('[data-action="commit-transfer"]')) throw new Error('the import preview is not ready'); }, 'the import preview');

    await click(page, '[data-action="commit-transfer"]');

    expect(asked[0], '导入覆盖了全部记录，确认框不能承诺一个 D1 留不下的恢复点').not.toContain('恢复点');
    expect(runtime.db.storedVersion()).toBe(5);
    runtime.close();
  });
});

/**
 * What the owner is told when a login fails is not a wording choice: 401 and
 * 503 call for opposite actions — check your password versus come back later —
 * and the old boolean contract handed the page the same `false` for both, so an
 * outage was reported as a typo.
 */
describe('Cloudflare 模式：登录失败的四类语义', () => {
  it('凭据被拒与服务不可用给出的是相反的修复指令', async () => {
    const wrong = deployed();
    const owner = openPage(wrong);
    await until(() => opened(owner), 'the initial read');
    await openEditor(owner, OWNER, 'not the owner password');

    expect(owner.container.textContent).toContain('账号或密码错误');
    wrong.close();

    // Reads still work; only opening the session fails. That is the shape of a
    // database that cannot write, and it must not reach the owner as a
    // password problem.
    const db = new SqliteD1({ failOn: /INSERT INTO owner_session/ });
    db.seed(JSON.stringify(ownerSnapshot()), 4);
    const broken = new CloudflareRuntime({ db, credential: CREDENTIAL, username: OWNER });
    const page = openPage(broken);
    await until(() => opened(page), 'the initial read');
    // The *correct* password — which is exactly the case the old contract
    // mislabelled.
    await openEditor(page);

    expect(page.container.textContent).toContain('服务暂时不可用');
    expect(page.container.textContent, '服务故障时不得指责密码').not.toContain('账号或密码错误');
    expect(page.container.querySelector('#bodyRecordForm')).toBeNull();
    broken.close();
  });

  it('被限流时提示稍后重试，而不是让本人去改密码', async () => {
    const runtime = deployed();
    // Spend the login budget the way a confused owner does: by retrying.
    //
    // What this pins is that *this backend* answers a limit the way the client
    // can tell apart from a refusal, and that the owner is told to come back
    // rather than to change a password. It does not pin the classification
    // itself: this backend sends its own message, and the page renders that
    // message whatever the outcome was called, so a mislabelled outcome would
    // be invisible here. `tests/auth.test.ts` pins the classification,
    // including the case where no message comes back and this deployment's
    // default wording is all the owner gets.
    for (let attempt = 0; attempt < 11; attempt += 1) {
      await runtime.fetch('/api/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: OWNER, password: 'not the owner password' }),
      });
    }

    const page = openPage(runtime);
    await until(() => opened(page), 'the initial read');
    await openEditor(page);

    expect(page.container.textContent).toContain('请一分钟后重试');
    expect(page.container.textContent, '限流不是密码问题').not.toContain('账号或密码错误');
    expect(page.container.querySelector('#bodyRecordForm')).toBeNull();
    expect(runtime.db.sessionRows(), '被限流的尝试不得留下会话').toBe(0);
    runtime.close();
  });

  it('登录请求本身断了时，不把网络故障说成密码错误', async () => {
    const runtime = deployed();
    const dropLogin = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(input) === '/api/login') throw new Error('connection reset');
      return runtime.fetch(input, init);
    };

    const page = openPage(runtime, { fetch: dropLogin });
    await until(() => opened(page), 'the initial read');
    await openEditor(page);

    expect(page.container.textContent).not.toContain('账号或密码错误');
    expect(page.container.textContent).toContain('重试');
    expect(page.container.querySelector('#bodyRecordForm')).toBeNull();
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
