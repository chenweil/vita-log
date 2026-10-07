/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountApp } from '../src/app';
import { createEmptySnapshot, type HealthSnapshot } from '../src/domain';
import type { EditorAuth } from '../src/auth';
import { LocalStorageHealthRepository, RECOVERY_KEY, SNAPSHOT_KEY, StorageError, type HealthDataRepository, type LoadResult, type StorageLike } from '../src/storage';
import { SqliteHealthRepository } from '../src/sqlite-storage';
import { createPublication, PublishedHealthRepository } from '../src/publication';
import { ReadOnlyEditorAuth } from '../src/auth';

class FakeRepository implements HealthDataRepository {
  commits: HealthSnapshot[] = [];
  failCommits = false;
  /** Mirrors the browser store, which does keep a recovery point on commit. */
  readonly keepsRecoveryPoint = true;

  constructor(private readonly result: LoadResult | StorageError) {}

  async load(): Promise<LoadResult> {
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }

  async commit(snapshot: HealthSnapshot): Promise<void> {
    if (this.failCommits) throw new StorageError('write-failed', '本地健康数据保存失败');
    this.commits.push(snapshot);
  }

  async loadRecovery(): Promise<HealthSnapshot> {
    return createEmptySnapshot();
  }
}

class FakeAuth implements EditorAuth {
  unlocked = false;
  canUnlock(): boolean { return true; }
  isUnlocked(): boolean { return this.unlocked; }
  async unlock(): Promise<boolean> { this.unlocked = true; return true; }
  async lock(): Promise<void> { this.unlocked = false; }
}

/** Wait for an observable condition; nothing here may be left to a turn count. */
const untilRendered = async (ready: () => boolean, what: string): Promise<void> => {
  for (let turn = 0; turn < 60 && !ready(); turn += 1) await new Promise((resolve) => { setTimeout(resolve, 0); });
  if (!ready()) throw new Error(`never reached: ${what}`);
};

/** Cases below stub these dialogs; give the next one a clean pair. */
const browserConfirm = window.confirm;
const browserPrompt = window.prompt;

afterEach(() => {
  document.body.innerHTML = '';
  window.confirm = browserConfirm;
  window.prompt = browserPrompt;
});

describe('static application boundary', () => {
  it('renders a read-only dashboard from the repository snapshot', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const snapshot = createEmptySnapshot('2026-09-28T00:00:00.000Z');
    snapshot.settings.name = 'Along';

    mountApp(container, new FakeRepository({ snapshot, status: 'loaded', scope: 'owner' }));
    await Promise.resolve();

    expect(container.textContent).toContain('Along，今天也稳稳向前。');
    expect(container.textContent).toContain('只读 · 本地');
    expect(container.textContent).toContain('0/4');
    expect(container.querySelectorAll('form')).toHaveLength(0);
    expect(container.querySelector('[data-action="reload"]')).not.toBeNull();
  });

  it('shows a storage error instead of rendering an empty dashboard', async () => {
    const container = document.createElement('div');
    document.body.append(container);

    mountApp(container, new FakeRepository(new StorageError('malformed', '本地数据损坏')));
    await Promise.resolve();

    expect(container.textContent).toContain('本地数据暂时不可用');
    expect(container.textContent).toContain('本地数据损坏');
    expect(container.textContent).not.toContain('当前体重 --');
  });

  it('requires owner access before allowing a body record to be saved', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const repository = new FakeRepository({ snapshot: createEmptySnapshot('2026-09-28T00:00:00.000Z'), status: 'loaded', scope: 'owner' });
    const auth = new FakeAuth();
    mountApp(container, repository, auth);
    await Promise.resolve();

    expect(container.querySelector('#bodyRecordForm')).toBeNull();
    container.querySelector<HTMLButtonElement>('[data-action="auth-toggle"]')?.click();
    await Promise.resolve();
    const authForm = container.querySelector<HTMLFormElement>('#authForm');
    expect(authForm).not.toBeNull();
    authForm?.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    // Unlocking re-reads the snapshot under the new session before the editor
    // opens, so the form appears only after that read lands. Counting promise
    // ticks was enough when the editor appeared immediately and is not enough
    // now that it waits on a repository call.
    await vi.waitFor(() => { if (!container.querySelector('#bodyRecordForm')) throw new Error('editor not open yet'); });

    const bodyForm = container.querySelector<HTMLFormElement>('#bodyRecordForm')!;
    expect(bodyForm).not.toBeNull();
    const weight = bodyForm?.querySelector<HTMLInputElement>('input[name="weightKg"]');
    const date = bodyForm?.querySelector<HTMLInputElement>('input[name="date"]');
    if (!weight || !date) throw new Error('body form fields missing');
    weight.value = '77.2';
    date.value = '2026-10-03';
    bodyForm?.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(repository.commits.at(-1)?.weights[0]).toMatchObject({ date: '2026-10-03', weightKg: 77.2 });
  });

  it('requires confirmation before replacing an existing body record', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const snapshot = createEmptySnapshot('2026-09-28T00:00:00.000Z');
    snapshot.weights.push({ id: 'w1', date: '2026-10-03', weightKg: 77, note: '', createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z' });
    const repository = new FakeRepository({ snapshot, status: 'loaded', scope: 'owner' });
    mountApp(container, repository, new FakeAuthUnlocked());
    await Promise.resolve();
    window.confirm = () => false;
    container.querySelector<HTMLButtonElement>('[data-action="edit-weight"]')?.click();
    const form = container.querySelector<HTMLFormElement>('#bodyRecordForm');
    const weight = form?.querySelector<HTMLInputElement>('input[name="weightKg"]');
    if (!form || !weight) throw new Error('edit form missing');
    weight.value = '76.5';
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();

    expect(repository.commits).toHaveLength(0);
  });

  it('keeps the restore control live where a save really does leave a recovery point', async () => {
    // The counterpart to "D1 must not enable the restore control on a save":
    // the browser store moves the previous snapshot into RECOVERY_KEY on every
    // commit, so here the control has to come alive and the restore has to work.
    // Without this, a fix that simply never enables it would pass everything.
    const seeded = createEmptySnapshot('2026-10-06T07:00:00.000Z');
    seeded.weights = [{ id: 'w1', date: '2026-10-06', weightKg: 76.4, note: '晨起空腹', createdAt: '2026-10-06T07:00:00.000Z', updatedAt: '2026-10-06T07:00:00.000Z' }];
    const values = new Map<string, string>([[SNAPSHOT_KEY, JSON.stringify(seeded)]]);
    const storage: StorageLike = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    };
    const container = document.createElement('div');
    document.body.append(container);
    const asked: string[] = [];
    window.confirm = (message?: string) => { asked.push(String(message ?? '')); return true; };
    mountApp(container, new LocalStorageHealthRepository(storage), new FakeAuthUnlocked());
    const settle = async (): Promise<void> => { for (let turn = 0; turn < 6; turn += 1) await Promise.resolve(); };
    await settle();

    const form = container.querySelector<HTMLFormElement>('#bodyRecordForm');
    if (!form) throw new Error('body form missing');
    form.querySelector<HTMLInputElement>('input[name="date"]')!.value = '2026-10-09';
    form.querySelector<HTMLInputElement>('input[name="weightKg"]')!.value = '75.1';
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await settle();

    const button = container.querySelector<HTMLButtonElement>('[data-action="restore-recovery"]');
    expect(container.textContent).toContain('已有可恢复快照');
    expect(button?.disabled, '浏览器存储确实留下了恢复点，恢复按钮必须可用').toBe(false);
    expect((JSON.parse(storage.getItem(RECOVERY_KEY)!) as HealthSnapshot).weights[0]?.weightKg).toBe(76.4);

    button!.click();
    await settle();

    expect((JSON.parse(storage.getItem(SNAPSHOT_KEY)!) as HealthSnapshot).weights[0]?.weightKg, '恢复后应当回到保存前的快照').toBe(76.4);

    // The browser store really does keep a recovery point, so it really can
    // promise one — including right before a clear. Fixing the online mode by
    // making every mode stop promising would pass the D1 assertions while
    // quietly deleting a capability the local build genuinely has.
    const clear = container.querySelector<HTMLButtonElement>('[data-action="clear-all"]');
    if (!clear) throw new Error('the clear control is missing');
    clear.click();
    await settle();

    expect(asked.at(-1), '浏览器存储留下恢复点，清空前的确认框就该承诺它').toContain('恢复点');
    expect(container.textContent).toContain('可从恢复点还原');
  });

  it('restoring a backup reloads through the one sequenced read path', async () => {
    // The interleaving a review reproduced. A refresh read is still in flight
    // when the owner restores a SQLite backup; the restore reads again.
    //
    // If that second read bypasses the page's read ordering, the repository
    // advances its own counter while the page does not — so the parked refresh
    // lands and is adopted by the page, while the repository still holds the
    // version from the restore. The next save is then accepted against *that*
    // version while carrying the stale snapshot: a 200 that overwrites the data
    // just restored, with no conflict and no error.
    const snapshotWith = (weightKg: number): HealthSnapshot => {
      const snapshot = createEmptySnapshot('2026-10-06T07:00:00.000Z');
      snapshot.weights = [{ id: 'w1', date: '2026-10-06', weightKg, note: '', createdAt: '2026-10-06T07:00:00.000Z', updatedAt: '2026-10-06T07:00:00.000Z' }];
      return snapshot;
    };
    // What the server holds when it receives a request — which is not when the
    // response arrives. A request dispatched earlier can answer from an older
    // state, and modelling that is the whole point.
    let server = { version: 3, weightKg: 76.4 };
    let parkNextRead = false;
    let parked = false;
    let releaseRead: () => void = () => {};
    const readPending = new Promise<void>((resolve) => { releaseRead = resolve; });
    const written: string[] = [];
    const client = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const path = String(input);
        const method = init?.method ?? 'GET';
        if (path === '/api/backups' && method === 'POST') return Response.json({ name: 'manual.sqlite' });
        if (path === '/api/backups') return Response.json([{ name: 'manual.sqlite', createdAt: '2026-10-05T08:00:00.000Z', summary: { total: 1, firstDate: '2026-10-06', lastDate: '2026-10-06', settings: { name: '', heightCm: 0, targetWeightKg: 0 } } }]);
        if (path === '/api/restore') {
          server = { version: 6, weightKg: 73.9 };
          return Response.json({ snapshot: snapshotWith(server.weightKg), version: server.version, empty: false });
        }
        if (path === '/api/snapshot' && method === 'GET') {
          const observed = { ...server };
          if (!parkNextRead) return Response.json({ snapshot: snapshotWith(observed.weightKg), version: observed.version, empty: false });
          parkNextRead = false;
          parked = true;
          await readPending;
          return Response.json({ snapshot: snapshotWith(observed.weightKg), version: observed.version, empty: false });
        }
        if (path === '/api/snapshot') {
          if (typeof init?.body === 'string') written.push(init.body);
          server = { ...server, version: server.version + 1 };
          return Response.json({ snapshot: snapshotWith(server.weightKg), version: server.version, empty: false });
        }
        throw new Error(`unexpected request: ${path}`);
      },
    };

    const container = document.createElement('div');
    document.body.append(container);
    window.prompt = () => '1';
    window.confirm = () => true;
    mountApp(container, new SqliteHealthRepository(client), new FakeAuthUnlocked());
    const settle = async (): Promise<void> => { for (let turn = 0; turn < 8; turn += 1) await new Promise((resolve) => { setTimeout(resolve, 0); }); };
    await settle();
    if (!container.querySelector('[data-action="restore-sqlite"]')) throw new Error('the restore control is missing');

    parkNextRead = true;
    container.querySelector<HTMLButtonElement>('[data-action="reload"]')!.click();
    await untilRendered(() => parked, 'the refresh to park');

    container.querySelector<HTMLButtonElement>('[data-action="restore-sqlite"]')!.click();
    await untilRendered(() => server.version === 6, 'the restore to land');
    releaseRead();
    await settle();

    // The parked refresh answered from before the restore. It was dispatched
    // first, so the page must drop it — the restore's own read is the newer one.
    expect(container.textContent, '过期的刷新读取不得覆盖刚恢复的快照').toContain('73.9');
    expect(container.textContent).not.toContain('76.4');

    const form = container.querySelector<HTMLFormElement>('#bodyRecordForm');
    if (!form) throw new Error('body form missing');
    form.querySelector<HTMLInputElement>('input[name="date"]')!.value = '2026-10-10';
    form.querySelector<HTMLInputElement>('input[name="weightKg"]')!.value = '72.5';
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await settle();

    // The version the save is built on has to be the one the restored snapshot
    // came from; anything else is a conflict the owner can see and act on.
    expect(written.at(-1), '保存必须以刚恢复的版本为基准').toContain('"expectedVersion":6');
  });

  it('renders a measurement trend when two measurements exist', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const snapshot = createEmptySnapshot('2026-09-28T00:00:00.000Z');
    snapshot.measurements.push(
      { id: 'm1', date: '2026-10-02', waistCm: 91, hipCm: 101, note: '', createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z' },
      { id: 'm2', date: '2026-10-03', waistCm: 90, hipCm: 100, note: '', createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z' },
    );
    mountApp(container, new FakeRepository({ snapshot, status: 'loaded', scope: 'owner' }), new FakeAuthUnlocked());
    await Promise.resolve();

    expect(container.querySelector('[aria-label="腰围与臀围趋势折线图"]')).not.toBeNull();
  });

  it('saves a diet record and shows its nutrition target summary in owner mode', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const repository = new FakeRepository({ snapshot: createEmptySnapshot('2026-09-28T00:00:00.000Z'), status: 'loaded', scope: 'owner' });
    mountApp(container, repository, new FakeAuthUnlocked());
    await Promise.resolve();
    const form = container.querySelector<HTMLFormElement>('#dietForm');
    if (!form) throw new Error('diet form missing');
    const set = (name: string, value: string): void => { const input = form.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`); if (!input) throw new Error(`${name} missing`); input.value = value; };
    set('food', '鸡胸肉');
    set('calorie', '200');
    set('protein', '35');
    set('fat', '4');
    set('carb', '2');
    set('sodium', '200');
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(repository.commits.at(-1)?.diets[0]).toMatchObject({ food: '鸡胸肉', calorie: 200, protein: 35 });
    expect(container.textContent).toContain('200');
  });

  it('shows diet persistence errors in the diet form and global status', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const repository = new FakeRepository({ snapshot: createEmptySnapshot('2026-09-28T00:00:00.000Z'), status: 'loaded', scope: 'owner' });
    repository.failCommits = true;
    mountApp(container, repository, new FakeAuthUnlocked());
    await Promise.resolve();
    const form = container.querySelector<HTMLFormElement>('#dietForm');
    if (!form) throw new Error('diet form missing');
    const set = (name: string, value: string): void => { const input = form.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`); if (!input) throw new Error(`${name} missing`); input.value = value; };
    set('food', '鸡胸肉'); set('calorie', '200'); set('protein', '35'); set('fat', '4'); set('carb', '2'); set('sodium', '200');
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(container.querySelector('.diet-form .form-error')?.textContent).toContain('本地健康数据保存失败');
    expect(container.textContent).toContain('本地健康数据保存失败');
  });

  it('renders a published snapshot with no mutation controls or owner unlock route', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const snapshot = createEmptySnapshot('2026-10-05T00:00:00.000Z');
    snapshot.settings.name = 'Published owner';
    mountApp(container, new PublishedHealthRepository(createPublication(snapshot, '2026-10-05T01:02:03.000Z')), new ReadOnlyEditorAuth(), { mode: 'reader', publishedAt: '2026-10-05T01:02:03.000Z' });
    await Promise.resolve();
    await Promise.resolve();

    expect(container.textContent).toContain('只读发布快照');
    expect(container.textContent).toContain('2026年10月5日');
    expect(container.textContent).toContain('不是实时同步');
    expect(container.textContent).not.toContain('进入编辑');
    expect(container.querySelectorAll('form')).toHaveLength(0);
    expect(container.querySelector('[data-action="clear-all"]')).toBeNull();
    expect(container.querySelector('[data-action="publish"]')).toBeNull();
    expect(container.querySelector('[data-action="auth-toggle"]')).toBeNull();
  });

  it('shows a visible import error without changing the owner snapshot', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const snapshot = createEmptySnapshot('2026-10-05T00:00:00.000Z');
    const repository = new FakeRepository({ snapshot, status: 'loaded', scope: 'owner' });
    mountApp(container, repository, new FakeAuthUnlocked());
    await Promise.resolve();

    const input = container.querySelector<HTMLInputElement>('#transferFile');
    if (!input) throw new Error('transfer file input missing');
    const file = new File([''], 'unreadable.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: async () => { throw new Error('file unavailable'); } });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(container.textContent).toContain('读取导入文件失败');
    expect(repository.commits).toHaveLength(0);
  });

  it('shows invalid JSON in import preview and prevents committing it', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const repository = new FakeRepository({ snapshot: createEmptySnapshot(), status: 'loaded', scope: 'owner' });
    mountApp(container, repository, new FakeAuthUnlocked());
    await Promise.resolve();
    const input = container.querySelector<HTMLInputElement>('#transferFile');
    if (!input) throw new Error('transfer file input missing');
    const file = new File(['{bad json'], 'broken.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: async () => '{bad json' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(container.querySelector('.transfer-errors')?.textContent).toBeTruthy();
    expect(container.querySelector<HTMLButtonElement>('[data-action="commit-transfer"]')?.disabled).toBe(true);
    expect(repository.commits).toHaveLength(0);
  });
});

class FakeAuthUnlocked implements EditorAuth {
  canUnlock(): boolean { return true; }
  isUnlocked(): boolean { return true; }
  async unlock(): Promise<boolean> { return true; }
  async lock(): Promise<void> {}
}

/**
 * The pure static build (06.1-04 acceptance 5).
 *
 * It mounts with no auth argument, so `mountApp`'s default `ReadOnlyEditorAuth`
 * is the whole authorization story — there is no server to ask. What it must
 * still do is read and export, and what it must stop doing is advertise an
 * unlock route it cannot honour.
 */
describe('纯静态模式', () => {
  const memory = (snapshot: HealthSnapshot): StorageLike => {
    const values = new Map<string, string>([[SNAPSHOT_KEY, JSON.stringify(snapshot)]]);
    return {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    };
  };

  const fixture = (): HealthSnapshot => {
    const snapshot = createEmptySnapshot('2026-10-06T07:00:00.000Z');
    snapshot.settings.name = '轻盈';
    snapshot.weights = [{ id: 'w1', date: '2026-10-06', weightKg: 76.4, note: '晨起空腹', createdAt: '2026-10-06T07:00:00.000Z', updatedAt: '2026-10-06T07:00:00.000Z' }];
    return snapshot;
  };

  const openStatic = async (): Promise<HTMLElement> => {
    const container = document.createElement('div');
    document.body.append(container);
    mountApp(container, new LocalStorageHealthRepository(memory(fixture())));
    for (let turn = 0; turn < 12 && !container.querySelector('[data-action="export-json"]'); turn += 1) await Promise.resolve();
    if (!container.querySelector('[data-action="export-json"]')) await new Promise((resolve) => { setTimeout(resolve, 0); });
    return container;
  };

  it('可以查看和导出数据', async () => {
    const container = await openStatic();
    expect(container.textContent).toContain('轻盈，今天也稳稳向前。');
    expect(container.textContent).toContain('只读 · 本地');
    // Where the data lives is part of what this build can honestly claim. The
    // online build asserts the opposite of this string for the same reason.
    expect(container.textContent).toContain('数据只保存在当前浏览器');
    expect(container.querySelector('[data-action="export-json"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-action="export-csv"]').length).toBeGreaterThan(0);
  });

  it('没有任何编辑入口，也不谎称有一个', async () => {
    const container = await openStatic();
    expect(container.querySelector('[data-action="auth-toggle"]')).toBeNull();
    // Each locked panel names the situation. Asserting on the data-manager line
    // alone would pass even if every panel still promised an unlock route,
    // because that panel carries different text.
    const lockedPanels = (container.textContent ?? '').match(/当前为纯静态只读页面，没有编辑入口。/g) ?? [];
    expect(lockedPanels.length, '体重与围度、饮食、步数与设置四处都应说明这是只读页面').toBe(4);
    expect(container.textContent).toContain('这是纯静态只读页面');
    expect(container.textContent).not.toContain('进入编辑模式');
    expect(container.textContent).not.toContain('进入本人编辑模式后可以');
    expect(container.querySelectorAll('form')).toHaveLength(0);
    expect(container.querySelector('[data-action="clear-all"]')).toBeNull();
    expect(container.querySelector('[data-action="commit-transfer"]')).toBeNull();
  });

  it('页面渲染本身不会写入存储', async () => {
    // "Read-only" has to mean nothing was sent, not that the page tried and the
    // write was swallowed somewhere below.
    const storage = memory(fixture());
    const repository = new LocalStorageHealthRepository(storage);
    const container = document.createElement('div');
    document.body.append(container);
    mountApp(container, repository);
    for (let turn = 0; turn < 12 && !container.querySelector('[data-action="export-json"]'); turn += 1) await Promise.resolve();

    expect(storage.getItem(RECOVERY_KEY)).toBeNull();
    expect((JSON.parse(storage.getItem(SNAPSHOT_KEY)!) as HealthSnapshot).weights[0]?.weightKg).toBe(76.4);
  });

  it('只读来自页面而不是被阉割的仓库：LocalStorageHealthRepository 本身仍会写入', async () => {
    // A repository that silently swallowed writes would let this whole file pass
    // while the control that actually protects the owner's data — never sending
    // a write at all — went untested.
    const storage = memory(fixture());
    const repository = new LocalStorageHealthRepository(storage);
    const next = fixture();
    next.weights[0] = { ...next.weights[0]!, weightKg: 70 };
    await repository.commit(next);
    expect((JSON.parse(storage.getItem(SNAPSHOT_KEY)!) as HealthSnapshot).weights[0]?.weightKg).toBe(70);
  });
});
