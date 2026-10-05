import { describe, expect, it } from 'vitest';
import { createEmptySnapshot, type HealthSnapshot } from '../src/domain';
import { createPublicSnapshot, parsePublicSnapshot, PublicSnapshotError, toHealthSnapshot } from '../src/public-snapshot';

const ownerSnapshot = (): HealthSnapshot => {
  const snapshot = createEmptySnapshot('2026-10-05T08:00:00.000Z');
  snapshot.settings.name = '轻盈';
  snapshot.weights = [{ id: 'w1', date: '2026-10-01', weightKg: 76.4, bodyfatPercent: 21.5, note: '晨起空腹', createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-01T08:00:00.000Z' }];
  snapshot.measurements = [{ id: 'm1', date: '2026-10-01', waistCm: 82, hipCm: 96, note: '腰围下降', createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-01T08:00:00.000Z' }];
  snapshot.steps = [{ id: 's1', date: '2026-10-01', steps: 9120, note: '公园散步', createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-01T08:00:00.000Z' }];
  snapshot.checkins = [{ id: 'c1', date: '2026-10-01', type: 'train', item: '力量 · 推类', done: true, note: '加重量', createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-01T08:00:00.000Z' }];
  snapshot.diets = [{ id: 'd1', date: '2026-10-01', meal: '午餐', food: '鸡胸沙拉', calorie: 520, protein: 42, fat: 12, carb: 48, sodium: 640, note: '自备午餐', createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-01T08:00:00.000Z' }];
  return snapshot;
};

describe('公开健康快照投影', () => {
  it('投影昵称、五类记录与备注，供访客查看完整看板', () => {
    const projection = createPublicSnapshot(ownerSnapshot());
    expect(projection.app).toBe('vita-log-public');
    expect(projection.settings.name).toBe('轻盈');
    expect(projection.weights[0]).toMatchObject({ weightKg: 76.4, bodyfatPercent: 21.5, note: '晨起空腹' });
    expect(projection.measurements[0]).toMatchObject({ waistCm: 82, hipCm: 96, note: '腰围下降' });
    expect(projection.steps[0]).toMatchObject({ steps: 9120, note: '公园散步' });
    expect(projection.checkins[0]).toMatchObject({ type: 'train', item: '力量 · 推类', done: true });
    expect(projection.diets[0]).toMatchObject({ food: '鸡胸沙拉', calorie: 520, note: '自备午餐' });
  });

  it('投影渲染完整看板所需的 display-facing settings', () => {
    const { settings } = createPublicSnapshot(ownerSnapshot());
    for (const key of ['name', 'gender', 'age', 'heightCm', 'startWeightKg', 'targetWeightKg', 'targetBodyfatPercent', 'activityFactor', 'calorieTarget', 'proteinTarget', 'fatTarget', 'carbTarget', 'sodiumTarget', 'trainingPlan', 'habits'] as const) {
      expect(settings, `缺少 ${key}`).toHaveProperty(key);
    }
    expect(Object.keys(settings.trainingPlan).sort()).toEqual(['0', '1', '2', '3', '4', '5', '6']);
  });

  it('不投影主题色、认证、会话、备份或内部元数据', () => {
    const projection = createPublicSnapshot(ownerSnapshot());
    expect(Object.keys(projection.settings)).not.toContain('primaryColor');
    expect(Object.keys(projection.settings)).not.toContain('accentColor');
    const serialized = JSON.stringify(projection);
    for (const forbidden of ['password', 'passwordHash', 'salt', 'username', 'session', 'token', 'cookie', 'backup', 'expectedVersion', 'auth']) {
      expect(serialized.toLowerCase(), `泄露 ${forbidden}`).not.toContain(forbidden.toLowerCase());
    }
  });

  it('丢弃投影外的附加字段，即使它们挂在快照顶层', () => {
    const polluted = { ...ownerSnapshot(), passwordHash: 'deadbeef', session: { token: 'abc' }, backups: ['daily.sqlite'] } as unknown as HealthSnapshot;
    const projection = createPublicSnapshot(polluted);
    expect(Object.keys(projection).sort()).toEqual(['app', 'checkins', 'diets', 'measurements', 'publicSchemaVersion', 'settings', 'sourceSchemaVersion', 'steps', 'updatedAt', 'weights']);
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain('deadbeef');
    expect(serialized).not.toContain('daily.sqlite');
  });

  it('往返序列化/解析后仍可还原为看板可用的 HealthSnapshot', () => {
    const projection = createPublicSnapshot(ownerSnapshot());
    const restored = toHealthSnapshot(parsePublicSnapshot(JSON.stringify(projection)));
    expect(restored).toEqual(ownerSnapshot());
  });

  it('拒绝不支持的版本与损坏数据，不退化为空快照', () => {
    expect(() => parsePublicSnapshot('{"app":"vita-log-public","publicSchemaVersion":99}')).toThrow(PublicSnapshotError);
    expect(() => parsePublicSnapshot('{"app":"vita-log","publicSchemaVersion":1}')).toThrow(PublicSnapshotError);
    expect(() => parsePublicSnapshot('not json')).toThrow(PublicSnapshotError);
    expect(() => parsePublicSnapshot(JSON.stringify({ ...createPublicSnapshot(ownerSnapshot()), weights: [{ id: 'w1', date: 'yesterday' }] }))).toThrow(PublicSnapshotError);
  });

  it('未初始化的空库不会伪装成空健康数据', () => {
    const empty = createPublicSnapshot(createEmptySnapshot('2026-10-05T08:00:00.000Z'));
    expect(empty.weights).toEqual([]);
    expect(empty.settings.name).toBe('');
    expect(empty.updatedAt).toBe('2026-10-05T08:00:00.000Z');
  });
});
