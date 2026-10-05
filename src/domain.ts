export const SNAPSHOT_SCHEMA_VERSION = 1 as const;

export type Gender = 'male' | 'female' | 'other';

export interface TrainingPlan {
  [dayOfWeek: string]: string[];
}

export interface HealthSettings {
  name: string;
  gender: Gender;
  age: number;
  heightCm: number;
  startWeightKg: number;
  targetWeightKg: number;
  targetBodyfatPercent: number;
  activityFactor: number;
  calorieTarget: number;
  proteinTarget: number;
  fatTarget: number;
  carbTarget: number;
  sodiumTarget: number;
  primaryColor: string;
  accentColor: string;
  trainingPlan: TrainingPlan;
  habits: string[];
}

export interface WeightRecord {
  id: string;
  date: string;
  weightKg: number;
  bodyfatPercent?: number;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface MeasurementRecord {
  id: string;
  date: string;
  waistCm: number;
  hipCm: number;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface StepRecord {
  id: string;
  date: string;
  steps: number;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export type CheckinType = 'train' | 'habit';

export interface CheckinRecord {
  id: string;
  date: string;
  type: CheckinType;
  item: string;
  done: boolean;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export type Meal = '早餐' | '午餐' | '晚餐' | '加餐' | string;

export interface DietRecord {
  id: string;
  date: string;
  meal: Meal;
  food: string;
  calorie: number;
  protein: number;
  fat: number;
  carb: number;
  sodium: number;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface HealthSnapshot {
  app: 'vita-log';
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  updatedAt: string;
  settings: HealthSettings;
  weights: WeightRecord[];
  measurements: MeasurementRecord[];
  steps: StepRecord[];
  checkins: CheckinRecord[];
  diets: DietRecord[];
}

export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

const DEFAULT_TRAINING_PLAN: TrainingPlan = {
  '0': ['休息 · 拉伸放松'],
  '1': ['力量 · 推类（胸/肩/三头）'],
  '2': ['有氧 · 快走/慢跑 30–40 分钟'],
  '3': ['力量 · 拉类（背/二头）'],
  '4': ['有氧 · 椭圆机/爬坡 30 分钟'],
  '5': ['力量 · 腿臀核心'],
  '6': ['有氧 · HIIT 20 分钟'],
};

const DEFAULT_HABITS = ['喝水 2L', '早睡 23:30 前', '无含糖饮料', '早餐有蛋白质'];

export function defaultSettings(): HealthSettings {
  return {
    name: '',
    gender: 'male',
    age: 37,
    heightCm: 164,
    startWeightKg: 78.3,
    targetWeightKg: 68,
    targetBodyfatPercent: 18,
    activityFactor: 1.375,
    calorieTarget: 1800,
    proteinTarget: 115,
    fatTarget: 55,
    carbTarget: 215,
    sodiumTarget: 2000,
    primaryColor: '#2F4A3C',
    accentColor: '#C26E4B',
    trainingPlan: cloneTrainingPlan(DEFAULT_TRAINING_PLAN),
    habits: [...DEFAULT_HABITS],
  };
}

export function createEmptySnapshot(updatedAt = new Date().toISOString()): HealthSnapshot {
  return {
    app: 'vita-log',
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    updatedAt,
    settings: defaultSettings(),
    weights: [],
    measurements: [],
    steps: [],
    checkins: [],
    diets: [],
  };
}

export function normalizeSnapshot(value: unknown): HealthSnapshot {
  if (!isRecord(value) || value.app !== 'vita-log' || value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new DomainError('不支持的健康数据快照版本');
  }

  const base = createEmptySnapshot(validTimestamp(value.updatedAt, 'updatedAt'));
  return {
    ...base,
    updatedAt: validTimestamp(value.updatedAt, 'updatedAt'),
    settings: normalizeSettings(value.settings),
    weights: normalizeWeights(value.weights),
    measurements: normalizeMeasurements(value.measurements),
    steps: normalizeSteps(value.steps),
    checkins: normalizeCheckins(value.checkins),
    diets: normalizeDiets(value.diets),
  };
}

export function calculateBmi(weightKg: number, heightCm: number): number | null {
  if (!positive(weightKg) || !positive(heightCm)) return null;
  return weightKg / ((heightCm / 100) ** 2);
}

export function calculateWhr(waistCm: number, hipCm: number): number | null {
  if (!positive(waistCm) || !positive(hipCm)) return null;
  return Math.round((waistCm / hipCm) * 100) / 100;
}

export function latestByDate<T extends { date: string }>(records: T[]): T | null {
  return records.reduce<T | null>((latest, record) => {
    if (!latest || record.date > latest.date) return record;
    return latest;
  }, null);
}

function normalizeSettings(value: unknown): HealthSettings {
  if (!isRecord(value)) throw new DomainError('设置数据格式无效');
  const gender = value.gender === 'male' || value.gender === 'female' || value.gender === 'other'
    ? value.gender
    : invalid('settings.gender');
  return {
    name: requiredStringValue(value.name, 'settings.name'),
    gender,
    age: strictBoundedNumber(value.age, 'settings.age', 1, 120),
    heightCm: strictBoundedNumber(value.heightCm, 'settings.heightCm', 80, 250),
    startWeightKg: strictBoundedNumber(value.startWeightKg, 'settings.startWeightKg', 20, 400),
    targetWeightKg: strictBoundedNumber(value.targetWeightKg, 'settings.targetWeightKg', 20, 400),
    targetBodyfatPercent: strictBoundedNumber(value.targetBodyfatPercent, 'settings.targetBodyfatPercent', 3, 70),
    activityFactor: strictBoundedNumber(value.activityFactor, 'settings.activityFactor', 1, 3),
    calorieTarget: strictBoundedNumber(value.calorieTarget, 'settings.calorieTarget', 0, 10000),
    proteinTarget: strictBoundedNumber(value.proteinTarget, 'settings.proteinTarget', 0, 1000),
    fatTarget: strictBoundedNumber(value.fatTarget, 'settings.fatTarget', 0, 1000),
    carbTarget: strictBoundedNumber(value.carbTarget, 'settings.carbTarget', 0, 2000),
    sodiumTarget: strictBoundedNumber(value.sodiumTarget, 'settings.sodiumTarget', 0, 20000),
    primaryColor: requiredStringValue(value.primaryColor, 'settings.primaryColor'),
    accentColor: requiredStringValue(value.accentColor, 'settings.accentColor'),
    trainingPlan: normalizeTrainingPlan(value.trainingPlan),
    habits: strictStringArray(value.habits, 'settings.habits'),
  };
}

function normalizeWeights(value: unknown): WeightRecord[] {
  return recordArray(value, '体重', (item) => ({
    id: requiredString(item.id, 'weight.id'),
    date: validDate(item.date, 'weight.date'),
    weightKg: boundedNumber(item.weightKg, 0, 20, 400, true),
    ...(item.bodyfatPercent == null ? {} : { bodyfatPercent: boundedNumber(item.bodyfatPercent, 0, 3, 70, true) }),
    note: stringValue(item.note, ''),
    createdAt: validTimestamp(item.createdAt, 'weight.createdAt'),
    updatedAt: validTimestamp(item.updatedAt, 'weight.updatedAt'),
  }));
}

function normalizeMeasurements(value: unknown): MeasurementRecord[] {
  return recordArray(value, '围度', (item) => ({
    id: requiredString(item.id, 'measurement.id'),
    date: validDate(item.date, 'measurement.date'),
    waistCm: boundedNumber(item.waistCm, 0, 40, 250, true),
    hipCm: boundedNumber(item.hipCm, 0, 40, 300, true),
    note: stringValue(item.note, ''),
    createdAt: validTimestamp(item.createdAt, 'measurement.createdAt'),
    updatedAt: validTimestamp(item.updatedAt, 'measurement.updatedAt'),
  }));
}

function normalizeSteps(value: unknown): StepRecord[] {
  return recordArray(value, '步数', (item) => ({
    id: requiredString(item.id, 'step.id'),
    date: validDate(item.date, 'step.date'),
    steps: boundedNumber(item.steps, 0, 0, 200000, true),
    note: stringValue(item.note, ''),
    createdAt: validTimestamp(item.createdAt, 'step.createdAt'),
    updatedAt: validTimestamp(item.updatedAt, 'step.updatedAt'),
  }));
}

function normalizeCheckins(value: unknown): CheckinRecord[] {
  return recordArray(value, '打卡', (item) => ({
    id: requiredString(item.id, 'checkin.id'),
    date: validDate(item.date, 'checkin.date'),
    type: item.type === 'habit' ? 'habit' : item.type === 'train' ? 'train' : invalid('checkin.type'),
    item: requiredString(item.item, 'checkin.item'),
    done: typeof item.done === 'boolean' ? item.done : invalidBoolean('checkin.done'),
    note: stringValue(item.note, ''),
    createdAt: validTimestamp(item.createdAt, 'checkin.createdAt'),
    updatedAt: validTimestamp(item.updatedAt, 'checkin.updatedAt'),
  }));
}

function normalizeDiets(value: unknown): DietRecord[] {
  return recordArray(value, '饮食', (item) => ({
    id: requiredString(item.id, 'diet.id'),
    date: validDate(item.date, 'diet.date'),
    meal: stringValue(item.meal, '加餐'),
    food: requiredString(item.food, 'diet.food'),
    calorie: boundedNumber(item.calorie, 0, 0, 20000, true),
    protein: boundedNumber(item.protein, 0, 0, 1000, true),
    fat: boundedNumber(item.fat, 0, 0, 1000, true),
    carb: boundedNumber(item.carb, 0, 0, 2000, true),
    sodium: boundedNumber(item.sodium, 0, 0, 20000, true),
    note: stringValue(item.note, ''),
    createdAt: validTimestamp(item.createdAt, 'diet.createdAt'),
    updatedAt: validTimestamp(item.updatedAt, 'diet.updatedAt'),
  }));
}

function normalizeTrainingPlan(value: unknown): TrainingPlan {
  if (!isRecord(value)) throw new DomainError('训练计划格式无效');
  const result: TrainingPlan = {};
  for (let day = 0; day < 7; day += 1) {
    result[String(day)] = strictStringArray(value[String(day)], `settings.trainingPlan.${day}`);
  }
  return result;
}

function recordArray<T>(value: unknown, label: string, mapper: (item: Record<string, unknown>) => T): T[] {
  if (!Array.isArray(value)) throw new DomainError(`${label}记录格式无效`);
  return value.map((item, index) => {
    if (!isRecord(item)) throw new DomainError(`${label}记录第 ${index + 1} 行格式无效`);
    return mapper(item);
  });
}

function cloneTrainingPlan(plan: TrainingPlan): TrainingPlan {
  return Object.fromEntries(Object.entries(plan).map(([key, values]) => [key, [...values]]));
}

function strictStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new DomainError(`${field}格式无效`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function requiredStringValue(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new DomainError(`${field}包含无效字符串`);
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new DomainError(`${field}缺少有效值`);
  return value;
}

function validDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new DomainError(`${field}不是有效日期`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new DomainError(`${field}不是有效日期`);
  return value;
}

function validTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    throw new DomainError(`${field}不是有效 UTC 时间戳`);
  }
  const parsed = new Date(value);
  const canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== canonical) {
    throw new DomainError(`${field}不是有效 UTC 时间戳`);
  }
  return value;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number, required = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    if (required) throw new DomainError('记录包含无效数值');
    return fallback;
  }
  return value;
}

function strictBoundedNumber(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new DomainError(`${field}包含无效数值`);
  }
  return value;
}

function positive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function invalid(field: string): never {
  throw new DomainError(`${field}包含不支持的值`);
}

function invalidBoolean(field: string): never {
  throw new DomainError(`${field}包含无效布尔值`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
