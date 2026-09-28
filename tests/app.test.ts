/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from 'vitest';
import { mountApp } from '../src/app';
import { createEmptySnapshot, type HealthSnapshot } from '../src/domain';
import { StorageError, type HealthDataRepository, type LoadResult } from '../src/storage';

class FakeRepository implements HealthDataRepository {
  constructor(private readonly result: LoadResult | StorageError) {}

  async load(): Promise<LoadResult> {
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }

  async commit(_snapshot: HealthSnapshot): Promise<void> {}

  async loadRecovery(): Promise<HealthSnapshot> {
    return createEmptySnapshot();
  }
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
});
