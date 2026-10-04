/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from 'vitest';
import { mountApp } from '../src/app';
import { createEmptySnapshot, type HealthSnapshot } from '../src/domain';
import type { EditorAuth } from '../src/auth';
import { StorageError, type HealthDataRepository, type LoadResult } from '../src/storage';
import { createPublication, PublishedHealthRepository } from '../src/publication';
import { ReadOnlyEditorAuth } from '../src/auth';

class FakeRepository implements HealthDataRepository {
  commits: HealthSnapshot[] = [];
  failCommits = false;

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
  isUnlocked(): boolean { return this.unlocked; }
  async unlock(): Promise<boolean> { this.unlocked = true; return true; }
  lock(): void { this.unlocked = false; }
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('static application boundary', () => {
  it('renders a read-only dashboard from the repository snapshot', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const snapshot = createEmptySnapshot('2026-09-28T00:00:00.000Z');
    snapshot.settings.name = 'Along';

    mountApp(container, new FakeRepository({ snapshot, status: 'loaded' }));
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
    const repository = new FakeRepository({ snapshot: createEmptySnapshot('2026-09-28T00:00:00.000Z'), status: 'loaded' });
    const auth = new FakeAuth();
    mountApp(container, repository, auth);
    await Promise.resolve();

    expect(container.querySelector('#bodyRecordForm')).toBeNull();
    container.querySelector<HTMLButtonElement>('[data-action="auth-toggle"]')?.click();
    await Promise.resolve();
    const authForm = container.querySelector<HTMLFormElement>('#authForm');
    expect(authForm).not.toBeNull();
    authForm?.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();

    const bodyForm = container.querySelector<HTMLFormElement>('#bodyRecordForm');
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
    const repository = new FakeRepository({ snapshot, status: 'loaded' });
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

  it('renders a measurement trend when two measurements exist', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const snapshot = createEmptySnapshot('2026-09-28T00:00:00.000Z');
    snapshot.measurements.push(
      { id: 'm1', date: '2026-10-02', waistCm: 91, hipCm: 101, note: '', createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z' },
      { id: 'm2', date: '2026-10-03', waistCm: 90, hipCm: 100, note: '', createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z' },
    );
    mountApp(container, new FakeRepository({ snapshot, status: 'loaded' }), new FakeAuthUnlocked());
    await Promise.resolve();

    expect(container.querySelector('[aria-label="腰围与臀围趋势折线图"]')).not.toBeNull();
  });

  it('saves a diet record and shows its nutrition target summary in owner mode', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const repository = new FakeRepository({ snapshot: createEmptySnapshot('2026-09-28T00:00:00.000Z'), status: 'loaded' });
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
    const repository = new FakeRepository({ snapshot: createEmptySnapshot('2026-09-28T00:00:00.000Z'), status: 'loaded' });
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
});

class FakeAuthUnlocked implements EditorAuth {
  isUnlocked(): boolean { return true; }
  async unlock(): Promise<boolean> { return true; }
  lock(): void {}
}
