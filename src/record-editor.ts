import type { HealthSnapshot, MeasurementRecord, WeightRecord } from './domain';

export interface BodyRecordInput {
  date: string;
  weightKg?: number;
  bodyfatPercent?: number;
  waistCm?: number;
  hipCm?: number;
  note: string;
}

export interface BodyRecordTarget {
  kind?: 'weight' | 'measurement';
  weightId?: string;
  measurementId?: string;
}

export type BodyRecordResult =
  | { ok: true; snapshot: HealthSnapshot }
  | { ok: false; error: string };

export function saveBodyRecords(
  snapshot: HealthSnapshot,
  input: BodyRecordInput,
  target: BodyRecordTarget | null,
  now: string,
): BodyRecordResult {
  if (!validDate(input.date)) return { ok: false, error: '请输入有效日期' };
  const hasWeight = input.weightKg !== undefined;
  const hasWaist = input.waistCm !== undefined;
  const hasHip = input.hipCm !== undefined;
  if (input.bodyfatPercent !== undefined && !hasWeight) return { ok: false, error: '体脂率需要同时填写体重' };
  if (!hasWeight && !hasWaist && !hasHip) return { ok: false, error: '至少填写体重或完整围度' };
  if (hasWaist !== hasHip) return { ok: false, error: '腰围和臀围需要同时填写' };
  if (hasWeight && (!Number.isFinite(input.weightKg) || input.weightKg! < 20 || input.weightKg! > 400)) return { ok: false, error: '请输入 20–400 kg 范围内的体重' };
  if (input.bodyfatPercent !== undefined && (!Number.isFinite(input.bodyfatPercent) || input.bodyfatPercent < 3 || input.bodyfatPercent > 70)) return { ok: false, error: '请输入 3–70% 范围内的体脂率' };
  if (hasWaist && (!Number.isFinite(input.waistCm) || input.waistCm! < 40 || input.waistCm! > 250 || !Number.isFinite(input.hipCm) || input.hipCm! < 40 || input.hipCm! > 300)) return { ok: false, error: '请输入有效的腰围和臀围' };

  const weightConflict = input.weightKg !== undefined && snapshot.weights.some((record) => record.date === input.date && record.id !== target?.weightId);
  if (weightConflict) return { ok: false, error: '该日期已有体重记录，请直接编辑那条记录' };
  const measurementConflict = hasWaist && snapshot.measurements.some((record) => record.date === input.date && record.id !== target?.measurementId);
  if (measurementConflict) return { ok: false, error: '该日期已有围度记录，请直接编辑那条记录' };

  let next: HealthSnapshot = { ...snapshot, updatedAt: now, weights: [...snapshot.weights], measurements: [...snapshot.measurements] };
  if (input.weightKg !== undefined) next.weights = upsertWeight(next.weights, input, target, now);
  if (hasWaist && input.hipCm !== undefined && input.waistCm !== undefined) next.measurements = upsertMeasurement(next.measurements, input, target, now);
  return { ok: true, snapshot: next };
}

export function deleteWeight(snapshot: HealthSnapshot, id: string, now: string): HealthSnapshot {
  return { ...snapshot, updatedAt: now, weights: snapshot.weights.filter((record) => record.id !== id) };
}

export function deleteMeasurement(snapshot: HealthSnapshot, id: string, now: string): HealthSnapshot {
  return { ...snapshot, updatedAt: now, measurements: snapshot.measurements.filter((record) => record.id !== id) };
}

function upsertWeight(records: WeightRecord[], input: BodyRecordInput, target: BodyRecordTarget | null, now: string): WeightRecord[] {
  const existing = target?.weightId ? records.find((record) => record.id === target.weightId) : undefined;
  const record: WeightRecord = {
    id: existing?.id ?? createId('w'),
    date: input.date,
    weightKg: input.weightKg!,
    ...(input.bodyfatPercent === undefined ? {} : { bodyfatPercent: input.bodyfatPercent }),
    note: target?.kind === 'measurement' && existing ? existing.note : input.note.trim(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  return existing ? records.map((item) => item.id === existing.id ? record : item) : [...records, record];
}

function upsertMeasurement(records: MeasurementRecord[], input: BodyRecordInput, target: BodyRecordTarget | null, now: string): MeasurementRecord[] {
  const existing = target?.measurementId ? records.find((record) => record.id === target.measurementId) : undefined;
  const record: MeasurementRecord = {
    id: existing?.id ?? createId('m'),
    date: input.date,
    waistCm: input.waistCm!,
    hipCm: input.hipCm!,
    note: target?.kind === 'weight' && existing ? existing.note : input.note.trim(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  return existing ? records.map((item) => item.id === existing.id ? record : item) : [...records, record];
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
