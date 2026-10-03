import type { CheckinRecord, CheckinType, HealthSnapshot, StepRecord } from './domain';

export interface StepInput {
  date: string;
  steps: number;
  note: string;
}

export type StepResult = { ok: true; snapshot: HealthSnapshot } | { ok: false; error: string };

export function saveStep(snapshot: HealthSnapshot, input: StepInput, targetId: string | null, now: string): StepResult {
  if (!validDate(input.date)) return { ok: false, error: '请输入有效日期' };
  if (!Number.isFinite(input.steps) || input.steps < 0 || input.steps > 200000) return { ok: false, error: '请输入 0–200000 范围内的步数' };
  if (snapshot.steps.some((record) => record.date === input.date && record.id !== targetId)) return { ok: false, error: '该日期已有步数记录，请直接编辑那条记录' };
  const existing = targetId ? snapshot.steps.find((record) => record.id === targetId) : undefined;
  const record: StepRecord = { id: existing?.id ?? createId('s'), date: input.date, steps: input.steps, note: input.note.trim(), createdAt: existing?.createdAt ?? now, updatedAt: now };
  const steps = existing ? snapshot.steps.map((item) => item.id === existing.id ? record : item) : [...snapshot.steps, record];
  return { ok: true, snapshot: { ...snapshot, updatedAt: now, steps } };
}

export function deleteStep(snapshot: HealthSnapshot, id: string, now: string): HealthSnapshot {
  return { ...snapshot, updatedAt: now, steps: snapshot.steps.filter((record) => record.id !== id) };
}

export function toggleCheckin(snapshot: HealthSnapshot, date: string, type: CheckinType, item: string, now: string): HealthSnapshot {
  const existing = snapshot.checkins.find((record) => record.date === date && record.type === type && record.item === item);
  const checkin: CheckinRecord = existing
    ? { ...existing, done: !existing.done, updatedAt: now }
    : { id: createId('c'), date, type, item, done: true, note: '', createdAt: now, updatedAt: now };
  const checkins = existing ? snapshot.checkins.map((record) => record.id === existing.id ? checkin : record) : [...snapshot.checkins, checkin];
  return { ...snapshot, updatedAt: now, checkins };
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
