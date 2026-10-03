import { describe, expect, it } from 'vitest';
import { createEmptySnapshot } from '../src/domain';
import {
  deleteMeasurement,
  deleteWeight,
  saveBodyRecords,
} from '../src/record-editor';

const NOW = '2026-10-03T00:00:00.000Z';

describe('body record editing', () => {
  it('saves one weight and one measurement from the body record input', () => {
    const result = saveBodyRecords(createEmptySnapshot(NOW), {
      date: '2026-10-03', weightKg: 77.2, bodyfatPercent: 21.5, waistCm: 90, hipCm: 100, note: '晨起空腹',
    }, null, NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.weights[0]).toMatchObject({ date: '2026-10-03', weightKg: 77.2, bodyfatPercent: 21.5 });
    expect(result.snapshot.measurements[0]).toMatchObject({ date: '2026-10-03', waistCm: 90, hipCm: 100 });
  });

  it('rejects a second weight for the same date before persistence', () => {
    const first = saveBodyRecords(createEmptySnapshot(NOW), { date: '2026-10-03', weightKg: 77, note: '' }, null, NOW);
    if (!first.ok) throw new Error(first.error);
    const second = saveBodyRecords(first.snapshot, { date: '2026-10-03', weightKg: 76.8, note: '' }, null, NOW);

    expect(second).toMatchObject({ ok: false, error: '该日期已有体重记录，请直接编辑那条记录' });
  });

  it('does not silently discard body-fat input without a weight', () => {
    const result = saveBodyRecords(createEmptySnapshot(NOW), { date: '2026-10-03', bodyfatPercent: 21, note: '' }, null, NOW);

    expect(result).toMatchObject({ ok: false, error: '体脂率需要同时填写体重' });
  });

  it('updates an existing record without creating a duplicate', () => {
    const first = saveBodyRecords(createEmptySnapshot(NOW), { date: '2026-10-03', weightKg: 77, note: '' }, null, NOW);
    if (!first.ok) throw new Error(first.error);
    const updated = saveBodyRecords(first.snapshot, { date: '2026-10-04', weightKg: 76.8, note: '晨重' }, { weightId: first.snapshot.weights[0].id }, NOW);

    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.snapshot.weights).toHaveLength(1);
    expect(updated.snapshot.weights[0]).toMatchObject({ date: '2026-10-04', weightKg: 76.8, note: '晨重' });
  });

  it('deletes weight and measurement records through explicit operations', () => {
    const saved = saveBodyRecords(createEmptySnapshot(NOW), { date: '2026-10-03', weightKg: 77, waistCm: 90, hipCm: 100, note: '' }, null, NOW);
    if (!saved.ok) throw new Error(saved.error);
    const withoutWeight = deleteWeight(saved.snapshot, saved.snapshot.weights[0].id, NOW);
    const withoutMeasurement = deleteMeasurement(withoutWeight, saved.snapshot.measurements[0].id, NOW);

    expect(withoutMeasurement.weights).toHaveLength(0);
    expect(withoutMeasurement.measurements).toHaveLength(0);
  });

  it('preserves the other record note when editing a paired record', () => {
    const saved = saveBodyRecords(createEmptySnapshot(NOW), { date: '2026-10-03', weightKg: 77, waistCm: 90, hipCm: 100, note: '围度备注' }, null, NOW);
    if (!saved.ok) throw new Error(saved.error);
    const updated = saveBodyRecords(saved.snapshot, { date: '2026-10-03', weightKg: 76.8, waistCm: 89, hipCm: 99, note: '体重备注' }, { kind: 'weight', weightId: saved.snapshot.weights[0].id, measurementId: saved.snapshot.measurements[0].id }, NOW);

    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.snapshot.weights[0].note).toBe('体重备注');
    expect(updated.snapshot.measurements[0].note).toBe('围度备注');
  });
});
