import { defaultSettings, isRecord, normalizeSnapshot, SNAPSHOT_SCHEMA_VERSION, type CheckinRecord, type DietRecord, type HealthSnapshot, type MeasurementRecord, type StepRecord, type WeightRecord } from './domain';

export const PUBLIC_SNAPSHOT_SCHEMA_VERSION = 1 as const;

/**
 * The one list of settings a visitor may read: identity, body metrics,
 * derived-metric inputs, nutrition targets, training plan and habits.
 *
 * This list is the single source of truth for the projection. The public type,
 * the copy out of the owner snapshot and the rehydration back into a
 * HealthSnapshot are all derived from it, so a field cannot be added to one and
 * silently forgotten in another. A setting added to HealthSettings later is
 * owner-only until it is listed here on purpose.
 */
const PUBLIC_SETTING_KEYS = [
  'name', 'gender', 'age', 'heightCm', 'startWeightKg', 'targetWeightKg',
  'targetBodyfatPercent', 'activityFactor', 'calorieTarget', 'proteinTarget',
  'fatTarget', 'carbTarget', 'sodiumTarget', 'trainingPlan', 'habits',
] as const satisfies readonly (keyof HealthSnapshot['settings'])[];

type PublicSettingKey = typeof PUBLIC_SETTING_KEYS[number];

/** The display-facing settings a visitor needs to render the whole dashboard. */
export type PublicHealthSettings = Pick<HealthSnapshot['settings'], PublicSettingKey>;

export interface PublicHealthSnapshot {
  app: 'vita-log-public';
  publicSchemaVersion: typeof PUBLIC_SNAPSHOT_SCHEMA_VERSION;
  sourceSchemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  updatedAt: string;
  settings: PublicHealthSettings;
  weights: WeightRecord[];
  measurements: MeasurementRecord[];
  steps: StepRecord[];
  checkins: CheckinRecord[];
  diets: DietRecord[];
}

export class PublicSnapshotError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PublicSnapshotError';
  }
}

/**
 * Build the anonymous response projection from the owner snapshot.
 *
 * Every field is copied by name out of a normalized snapshot instead of being
 * spread. normalizeSnapshot already rebuilds each allowed field, so credentials,
 * session state, backup listings, theme colors and owner-only internals cannot
 * ride along even when a caller hands in a polluted object.
 */
export function createPublicSnapshot(snapshot: HealthSnapshot): PublicHealthSnapshot {
  const source = normalizeSnapshot(snapshot);
  return {
    app: 'vita-log-public',
    publicSchemaVersion: PUBLIC_SNAPSHOT_SCHEMA_VERSION,
    sourceSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
    updatedAt: source.updatedAt,
    settings: publicSettings(source.settings),
    weights: source.weights.map(record => ({ ...record })),
    measurements: source.measurements.map(record => ({ ...record })),
    steps: source.steps.map(record => ({ ...record })),
    checkins: source.checkins.map(record => ({ ...record })),
    diets: source.diets.map(record => ({ ...record })),
  };
}

/**
 * Rehydrate a public projection into the HealthSnapshot the dashboard renders.
 *
 * Theme colors are not public, so they come from the shared defaults rather than
 * from a value the visitor could influence. This keeps a single domain model:
 * the browser still renders the same snapshot shape it always has.
 */
export function toHealthSnapshot(projection: PublicHealthSnapshot): HealthSnapshot {
  // Only the allow-listed keys are taken from the projection, so it can never
  // supply a value for an owner-only field. Everything else — today the two
  // theme colors — comes from the shared defaults, which also means a setting
  // added to HealthSettings later needs no change here.
  return normalizeSnapshot({
    app: 'vita-log',
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    updatedAt: projection.updatedAt,
    settings: { ...defaultSettings(), ...publicSettings(projection.settings) },
    weights: projection.weights,
    measurements: projection.measurements,
    steps: projection.steps,
    checkins: projection.checkins,
    diets: projection.diets,
  });
}

export function parsePublicSnapshot(raw: string): PublicHealthSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new PublicSnapshotError('公开健康数据不是有效的 JSON', { cause: error });
  }
  return readPublicSnapshot(value);
}

function readPublicSnapshot(value: unknown): PublicHealthSnapshot {
  if (!isRecord(value)
    || value.app !== 'vita-log-public'
    || value.publicSchemaVersion !== PUBLIC_SNAPSHOT_SCHEMA_VERSION
    || value.sourceSchemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new PublicSnapshotError('不支持的公开健康数据版本');
  }

  try {
    // Round-tripping through the owner model is what enforces the field set:
    // createPublicSnapshot only re-emits the fields the visitor may read.
    return createPublicSnapshot(toHealthSnapshot({
      app: 'vita-log-public',
      publicSchemaVersion: PUBLIC_SNAPSHOT_SCHEMA_VERSION,
      sourceSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
      updatedAt: value.updatedAt as string,
      settings: value.settings as PublicHealthSettings,
      weights: value.weights as WeightRecord[],
      measurements: value.measurements as MeasurementRecord[],
      steps: value.steps as StepRecord[],
      checkins: value.checkins as CheckinRecord[],
      diets: value.diets as DietRecord[],
    }));
  } catch (error) {
    if (error instanceof PublicSnapshotError) throw error;
    throw new PublicSnapshotError('公开健康数据内容无效', { cause: error });
  }
}

/**
 * Copy out exactly the allow-listed keys, and nothing else. Both directions of
 * the boundary go through here, so there is a single place to audit. It accepts
 * the full owner settings or an already-projected subset, since either side
 * has to survive the round trip.
 */
function publicSettings(settings: PublicHealthSettings): PublicHealthSettings {
  const picked = Object.fromEntries(PUBLIC_SETTING_KEYS.map(key => [key, settings[key]])) as PublicHealthSettings;
  return {
    ...picked,
    trainingPlan: Object.fromEntries(Object.entries(picked.trainingPlan).map(([day, items]) => [day, [...items]])),
    habits: [...picked.habits],
  };
}
