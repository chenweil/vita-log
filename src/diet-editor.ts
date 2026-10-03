import type { DietRecord, HealthSnapshot, Meal } from './domain';

export interface DietInput {
  date: string;
  meal: Meal;
  food: string;
  calorie: number;
  protein: number;
  fat: number;
  carb: number;
  sodium: number;
  note: string;
}

export type DietResult = { ok: true; snapshot: HealthSnapshot } | { ok: false; error: string };

export function saveDiet(snapshot: HealthSnapshot, input: DietInput, targetId: string | null, now: string): DietResult {
  if (!validDate(input.date)) return { ok: false, error: '请输入有效日期' };
  if (!input.food.trim()) return { ok: false, error: '请填写食物名称' };
  if (!input.meal.trim()) return { ok: false, error: '请选择餐次' };
  const nutrients: Array<[number, string, number]> = [[input.calorie, '热量', 20000], [input.protein, '蛋白质', 1000], [input.fat, '脂肪', 1000], [input.carb, '碳水', 2000], [input.sodium, '钠', 20000]];
  const invalid = nutrients.find(([value, , max]) => !Number.isFinite(value) || value < 0 || value > max);
  if (invalid) return { ok: false, error: `${invalid[1]}必须在 0–${invalid[2]} 范围内` };
  const existing = targetId ? snapshot.diets.find((record) => record.id === targetId) : undefined;
  const record: DietRecord = { id: existing?.id ?? createId('d'), date: input.date, meal: input.meal.trim(), food: input.food.trim(), calorie: input.calorie, protein: input.protein, fat: input.fat, carb: input.carb, sodium: input.sodium, note: input.note.trim(), createdAt: existing?.createdAt ?? now, updatedAt: now };
  const diets = existing ? snapshot.diets.map((item) => item.id === existing.id ? record : item) : [...snapshot.diets, record];
  return { ok: true, snapshot: { ...snapshot, updatedAt: now, diets } };
}

export function deleteDiet(snapshot: HealthSnapshot, id: string, now: string): HealthSnapshot {
  return { ...snapshot, updatedAt: now, diets: snapshot.diets.filter((record) => record.id !== id) };
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
