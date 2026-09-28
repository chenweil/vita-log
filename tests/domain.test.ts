import { describe, expect, it } from 'vitest';
import {
  calculateBmi,
  calculateWhr,
  createEmptySnapshot,
  normalizeSnapshot,
} from '../src/domain';
import { parseSnapshotJson } from '../src/import';

describe('health domain', () => {
  it('creates the versioned snapshot shape used by the local repository', () => {
    const snapshot = createEmptySnapshot('2026-09-28T00:00:00.000Z');

    expect(snapshot).toMatchObject({
      app: 'vita-log',
      schemaVersion: 1,
      updatedAt: '2026-09-28T00:00:00.000Z',
      weights: [],
      measurements: [],
      steps: [],
      checkins: [],
      diets: [],
    });
    expect(snapshot.settings.heightCm).toBeGreaterThan(0);
  });

  it('normalizes a persisted snapshot without trusting derived or unknown fields', () => {
    const base = createEmptySnapshot('2026-09-28T00:00:00.000Z');
    const snapshot = normalizeSnapshot({
      ...base,
      settings: { ...base.settings, name: 'Along' },
      weights: [{ id: 'w1', date: '2026-09-28', weightKg: 75.4, bodyfatPercent: 20, createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z' }],
      measurements: [{ id: 'm1', date: '2026-09-28', waistCm: 85, hipCm: 100, whr: 0, createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z' }],
      unknown: 'ignored',
    });

    expect(snapshot.settings.name).toBe('Along');
    expect(snapshot.weights[0]).toMatchObject({ id: 'w1', weightKg: 75.4 });
    expect('whr' in snapshot.measurements[0]).toBe(false);
    expect('unknown' in snapshot).toBe(false);
  });

  it('calculates independent body metrics from known inputs', () => {
    expect(calculateBmi(75.4, 164)).toBeCloseTo(28.0, 1);
    expect(calculateWhr(85, 100)).toBe(0.85);
    expect(calculateWhr(85, 0)).toBeNull();
  });

  it('reports invalid JSON as an import validation result without mutating data', () => {
    const result = parseSnapshotJson('{not-json');

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('备份文件不是有效 JSON');
    expect(result.snapshot).toBeUndefined();
  });

  it('rejects corrupted persisted fields instead of coercing them into valid data', () => {
    const base = createEmptySnapshot('2026-09-28T00:00:00.000Z');
    const corrupted = {
      ...base,
      checkins: [{
        id: 'c1', date: '2026-09-28', type: 'habit', item: '喝水', done: 'false', note: '',
        createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z',
      }],
    };

    expect(() => normalizeSnapshot(corrupted)).toThrow('checkin.done包含无效布尔值');
  });

  it('rejects timestamps that are not ISO UTC values', () => {
    const base = createEmptySnapshot('2026-09-28T00:00:00.000Z');

    expect(() => normalizeSnapshot({ ...base, updatedAt: 'x' })).toThrow('updatedAt不是有效 UTC 时间戳');
    expect(() => normalizeSnapshot({ ...base, updatedAt: '2026-02-31T00:00:00.000Z' })).toThrow('updatedAt不是有效 UTC 时间戳');
  });
});
