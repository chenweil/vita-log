import { describe, expect, it } from 'vitest';
import { createEmptySnapshot } from '../src/domain';
import { deleteDiet, saveDiet } from '../src/diet-editor';

const NOW = '2026-10-03T00:00:00.000Z';

describe('diet editing', () => {
  it('allows multiple foods in the same meal and date', () => {
    const first = saveDiet(createEmptySnapshot(NOW), { date: '2026-10-03', meal: '午餐', food: '鸡胸肉', calorie: 200, protein: 35, fat: 4, carb: 2, sodium: 200, note: '' }, null, NOW);
    if (!first.ok) throw new Error(first.error);
    const second = saveDiet(first.snapshot, { date: '2026-10-03', meal: '午餐', food: '糙米饭', calorie: 220, protein: 5, fat: 1, carb: 45, sodium: 5, note: '' }, null, NOW);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.snapshot.diets).toHaveLength(2);
  });

  it('updates and deletes a food by stable id', () => {
    const first = saveDiet(createEmptySnapshot(NOW), { date: '2026-10-03', meal: '早餐', food: '鸡蛋', calorie: 90, protein: 7, fat: 6, carb: 1, sodium: 60, note: '' }, null, NOW);
    if (!first.ok) throw new Error(first.error);
    const id = first.snapshot.diets[0].id;
    const updated = saveDiet(first.snapshot, { date: '2026-10-03', meal: '早餐', food: '鸡蛋 2 个', calorie: 180, protein: 14, fat: 12, carb: 2, sodium: 120, note: '更新份量' }, id, NOW);

    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.snapshot.diets).toHaveLength(1);
    expect(updated.snapshot.diets[0]).toMatchObject({ id, food: '鸡蛋 2 个', calorie: 180, note: '更新份量' });
    expect(deleteDiet(updated.snapshot, id, NOW).diets).toHaveLength(0);
  });

  it('rejects invalid food or nutrient values', () => {
    const result = saveDiet(createEmptySnapshot(NOW), { date: '2026-10-03', meal: '午餐', food: '', calorie: -1, protein: 0, fat: 0, carb: 0, sodium: 0, note: '' }, null, NOW);

    expect(result).toMatchObject({ ok: false, error: '请填写食物名称' });
  });
});
