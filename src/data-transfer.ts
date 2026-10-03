import { calculateWhr, normalizeSnapshot, type CheckinRecord, type DietRecord, type HealthSnapshot, type MeasurementRecord, type StepRecord, type WeightRecord } from './domain';

export type CsvKind = 'weight' | 'measurement' | 'checkin' | 'step' | 'diet';

export interface TransferPreview {
  valid: boolean;
  snapshot?: HealthSnapshot;
  accepted: number;
  conflicts: number;
  duplicates: number;
  errors: string[];
  details: string[];
}

const CSV_HEADERS: Record<CsvKind, string[]> = {
  weight: ['日期', '体重(kg)', '体脂率(%)', '备注'],
  measurement: ['日期', '腰围(cm)', '臀围(cm)', '腰臀比(WHR)', '备注'],
  checkin: ['日期', '类型', '项目', '完成', '备注'],
  step: ['日期', '步数', '备注'],
  diet: ['日期', '餐次', '食物', '热量(kcal)', '蛋白质(g)', '脂肪(g)', '碳水(g)', '钠(mg)', '备注'],
};

export function exportJson(snapshot: HealthSnapshot): string {
  return JSON.stringify({ ...snapshot, exportedAt: new Date().toISOString() }, null, 2);
}

export function exportCsv(snapshot: HealthSnapshot, kind: CsvKind): string {
  const rows: Array<Array<string | number>> = [CSV_HEADERS[kind]];
  if (kind === 'weight') snapshot.weights.forEach((record) => rows.push([record.date, record.weightKg, record.bodyfatPercent ?? '', record.note]));
  if (kind === 'measurement') snapshot.measurements.forEach((record) => rows.push([record.date, record.waistCm, record.hipCm, calculateWhr(record.waistCm, record.hipCm) ?? '', record.note]));
  if (kind === 'checkin') snapshot.checkins.forEach((record) => rows.push([record.date, record.type === 'habit' ? '习惯' : '训练', record.item, record.done ? '是' : '否', record.note]));
  if (kind === 'step') snapshot.steps.forEach((record) => rows.push([record.date, record.steps, record.note]));
  if (kind === 'diet') snapshot.diets.forEach((record) => rows.push([record.date, record.meal, record.food, record.calorie, record.protein, record.fat, record.carb, record.sodium, record.note]));
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
}

export function importJsonPreview(text: string, current: HealthSnapshot): TransferPreview {
  try {
    const parsed = JSON.parse(text) as unknown;
    const snapshot = normalizeSnapshot(parsed);
    return { valid: true, snapshot, accepted: countRecords(snapshot), conflicts: 0, duplicates: 0, errors: [], details: [] };
  } catch (error) {
    return { valid: false, accepted: 0, conflicts: 0, duplicates: 0, errors: [error instanceof Error ? error.message : '备份文件不是有效 JSON'], details: [], snapshot: current };
  }
}

export function importCsvPreview(current: HealthSnapshot, kind: CsvKind, text: string, now: string): TransferPreview {
  let rows: string[][];
  try { rows = parseCsv(text); } catch (error) { return { valid: false, snapshot: current, accepted: 0, conflicts: 0, duplicates: 0, errors: [error instanceof Error ? error.message : 'CSV 文件格式无效'], details: [] }; }
  const errors: string[] = [];
  const details: string[] = [];
  if (rows.length === 0) return { valid: false, snapshot: current, accepted: 0, conflicts: 0, duplicates: 0, errors: ['CSV 文件没有数据行'], details };
  if (rows[0].map((cell) => cell.trim()).join(',') !== CSV_HEADERS[kind].join(',')) return { valid: false, snapshot: current, accepted: 0, conflicts: 0, duplicates: 0, errors: ['CSV 表头与选择的导入类型不匹配'], details };
  const dataRows = rows.slice(1);
  if (dataRows.every((row) => row.every((cell) => cell.trim() === ''))) return { valid: false, snapshot: current, accepted: 0, conflicts: 0, duplicates: 0, errors: ['CSV 文件没有数据行'], details };
  let next = cloneSnapshot(current);
  let accepted = 0;
  let conflicts = 0;
  let duplicates = 0;
  dataRows.forEach((row, index) => {
    if (row.every((cell) => cell.trim() === '')) return;
    if (row.length !== CSV_HEADERS[kind].length) { errors.push(`第 ${index + 2} 行列数不匹配`); return; }
    const result = parseCsvRecord(kind, row, index + 2, now);
    if ('error' in result) { errors.push(result.error); return; }
    const duplicate = findDuplicate(next, kind, result.record);
    if (duplicate === 'conflict') { conflicts += 1; details.push(`第 ${index + 2} 行：与当前记录冲突，已保留当前数据`); return; }
    if (duplicate === 'duplicate') { duplicates += 1; details.push(`第 ${index + 2} 行：与当前记录重复，已跳过`); return; }
    next = appendRecord(next, kind, result.record);
    accepted += 1;
  });
  return { valid: errors.length === 0, snapshot: next, accepted, conflicts, duplicates, errors, details };
}

function parseCsvRecord(kind: CsvKind, row: string[], line: number, now: string): { record: WeightRecord | MeasurementRecord | CheckinRecord | StepRecord | DietRecord } | { error: string } {
  const value = (index: number): string => (row[index] ?? '').trim();
  const date = value(0);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) return { error: `第 ${line} 行日期无效` };
  const number = (index: number): number => Number(value(index));
  const numeric = (index: number, label: string): number | string => Number.isFinite(number(index)) ? number(index) : `第 ${line} 行${label}无效`;
  if (kind === 'weight') {
    const weight = numeric(1, '体重'); if (typeof weight === 'string' || weight < 20 || weight > 400) return { error: typeof weight === 'string' ? weight : `第 ${line} 行体重超出范围` };
    const bodyfat = value(2) === '' ? undefined : numeric(2, '体脂率'); if (typeof bodyfat === 'string' || (bodyfat !== undefined && (bodyfat < 3 || bodyfat > 70))) return { error: typeof bodyfat === 'string' ? bodyfat : `第 ${line} 行体脂率超出范围` };
    return { record: { id: createId('w'), date, weightKg: weight, ...(bodyfat === undefined ? {} : { bodyfatPercent: bodyfat }), note: value(3), createdAt: now, updatedAt: now } };
  }
  if (kind === 'measurement') {
    const waist = numeric(1, '腰围'); const hip = numeric(2, '臀围');
    if (typeof waist === 'string' || typeof hip === 'string' || waist < 40 || hip < 40) return { error: `第 ${line} 行围度无效` };
    return { record: { id: createId('m'), date, waistCm: waist, hipCm: hip, note: value(4), createdAt: now, updatedAt: now } };
  }
  if (kind === 'step') {
    const steps = numeric(1, '步数'); if (typeof steps === 'string' || steps < 0 || steps > 200000) return { error: typeof steps === 'string' ? steps : `第 ${line} 行步数超出范围` };
    return { record: { id: createId('s'), date, steps, note: value(2), createdAt: now, updatedAt: now } };
  }
  if (kind === 'checkin') {
    const type = value(1) === '习惯' || value(1) === 'habit' ? 'habit' : value(1) === '训练' || value(1) === 'train' ? 'train' : null;
    if (!type || !value(2)) return { error: `第 ${line} 行打卡类型或项目无效` };
    return { record: { id: createId('c'), date, type, item: value(2), done: ['是', 'true', '1', '完成'].includes(value(3).toLowerCase()), note: value(4), createdAt: now, updatedAt: now } };
  }
  const values = [3, 4, 5, 6, 7].map((index) => numeric(index, CSV_HEADERS.diet[index]));
  if (values.some((value) => typeof value === 'string' || Number(value) < 0)) return { error: `第 ${line} 行营养数值无效` };
  if (!value(2)) return { error: `第 ${line} 行食物为空` };
  return { record: { id: createId('d'), date, meal: value(1), food: value(2), calorie: Number(values[0]), protein: Number(values[1]), fat: Number(values[2]), carb: Number(values[3]), sodium: Number(values[4]), note: value(9), createdAt: now, updatedAt: now } };
}

function findDuplicate(snapshot: HealthSnapshot, kind: CsvKind, record: WeightRecord | MeasurementRecord | CheckinRecord | StepRecord | DietRecord): 'duplicate' | 'conflict' | null {
  if (kind === 'weight' || kind === 'measurement' || kind === 'step') {
    const collection = kind === 'weight' ? snapshot.weights : kind === 'measurement' ? snapshot.measurements : snapshot.steps;
    const existing = collection.find((item) => item.date === record.date);
    if (!existing) return null;
    if (kind === 'weight') { const left = existing as WeightRecord; const right = record as WeightRecord; return left.weightKg === right.weightKg && left.bodyfatPercent === right.bodyfatPercent && left.note === right.note ? 'duplicate' : 'conflict'; }
    if (kind === 'measurement') { const left = existing as MeasurementRecord; const right = record as MeasurementRecord; return left.waistCm === right.waistCm && left.hipCm === right.hipCm && left.note === right.note ? 'duplicate' : 'conflict'; }
    const left = existing as StepRecord; const right = record as StepRecord; return left.steps === right.steps && left.note === right.note ? 'duplicate' : 'conflict';
  }
  if (kind === 'checkin') {
    const item = record as CheckinRecord;
    const existing = snapshot.checkins.find((entry) => entry.date === item.date && entry.type === item.type && entry.item === item.item);
    if (!existing) return null;
    return existing.done === item.done && existing.note === item.note ? 'duplicate' : 'conflict';
  }
  const item = record as DietRecord;
  const existing = snapshot.diets.find((entry) => entry.date === item.date && entry.meal === item.meal && entry.food === item.food);
  if (!existing) return null;
  return existing.calorie === item.calorie && existing.protein === item.protein && existing.fat === item.fat && existing.carb === item.carb && existing.sodium === item.sodium && existing.note === item.note ? 'duplicate' : 'conflict';
}

function appendRecord(snapshot: HealthSnapshot, kind: CsvKind, record: WeightRecord | MeasurementRecord | CheckinRecord | StepRecord | DietRecord): HealthSnapshot {
  if (kind === 'weight') return { ...snapshot, weights: [...snapshot.weights, record as WeightRecord] };
  if (kind === 'measurement') return { ...snapshot, measurements: [...snapshot.measurements, record as MeasurementRecord] };
  if (kind === 'checkin') return { ...snapshot, checkins: [...snapshot.checkins, record as CheckinRecord] };
  if (kind === 'step') return { ...snapshot, steps: [...snapshot.steps, record as StepRecord] };
  return { ...snapshot, diets: [...snapshot.diets, record as DietRecord] };
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = text.charCodeAt(0) === 0xfeff ? 1 : 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) { if (char === '\r' && text[index + 1] === '\n') index += 1; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += char;
  }
  if (quoted) throw new Error('CSV 文件包含未闭合的引号');
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function csvCell(value: string | number): string {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function cloneSnapshot(snapshot: HealthSnapshot): HealthSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as HealthSnapshot;
}

function countRecords(snapshot: HealthSnapshot): number {
  return snapshot.weights.length + snapshot.measurements.length + snapshot.steps.length + snapshot.checkins.length + snapshot.diets.length;
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
