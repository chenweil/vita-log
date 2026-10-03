import { describe, expect, it } from 'vitest';
import { createEmptySnapshot } from '../src/domain';
import { deleteStep, saveStep, toggleCheckin } from '../src/activity-editor';

const NOW = '2026-10-03T00:00:00.000Z';

describe('activity editing', () => {
  it('creates, updates and deletes one step record per day', () => {
    const first = saveStep(createEmptySnapshot(NOW), { date: '2026-10-03', steps: 8200, note: '通勤' }, null, NOW);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const duplicate = saveStep(first.snapshot, { date: '2026-10-03', steps: 9000, note: '' }, null, NOW);
    expect(duplicate).toMatchObject({ ok: false, error: '该日期已有步数记录，请直接编辑那条记录' });
    const updated = saveStep(first.snapshot, { date: '2026-10-04', steps: 9000, note: '散步' }, first.snapshot.steps[0].id, NOW);
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.snapshot.steps[0]).toMatchObject({ date: '2026-10-04', steps: 9000 });
    expect(deleteStep(updated.snapshot, updated.snapshot.steps[0].id, NOW).steps).toHaveLength(0);
  });

  it('toggles a check-in and creates a missing check-in', () => {
    const snapshot = createEmptySnapshot(NOW);
    const first = toggleCheckin(snapshot, '2026-10-03', 'habit', '喝水 2L', NOW);
    expect(first.checkins[0]).toMatchObject({ date: '2026-10-03', type: 'habit', item: '喝水 2L', done: true });
    const second = toggleCheckin(first, '2026-10-03', 'habit', '喝水 2L', NOW);
    expect(second.checkins[0].done).toBe(false);
  });
});
