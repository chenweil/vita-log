import { normalizeSnapshot, SNAPSHOT_SCHEMA_VERSION, type HealthSnapshot } from './domain';
import { StorageError, type HealthDataRepository, type LoadResult } from './storage';

export const PUBLICATION_SCHEMA_VERSION = 1 as const;

export interface PublishedHealthSnapshot {
  app: 'vita-log-publication';
  publicationSchemaVersion: typeof PUBLICATION_SCHEMA_VERSION;
  publishedAt: string;
  sourceSchemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  snapshot: HealthSnapshot;
}

export class PublicationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PublicationError';
  }
}

/**
 * Build the public projection from the accepted owner snapshot.
 * normalizeSnapshot deliberately reconstructs every allowed field, so extra
 * credentials, session state, recovery data, or pending operation fields can
 * never cross the publication boundary.
 */
export function createPublication(snapshot: HealthSnapshot, publishedAt = new Date().toISOString()): PublishedHealthSnapshot {
  return {
    app: 'vita-log-publication',
    publicationSchemaVersion: PUBLICATION_SCHEMA_VERSION,
    publishedAt: validTimestamp(publishedAt, '发布时间'),
    sourceSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshot: normalizeSnapshot(snapshot),
  };
}

export function serializePublication(publication: PublishedHealthSnapshot): string {
  return JSON.stringify(createPublication(publication.snapshot, publication.publishedAt), null, 2);
}

export function parsePublication(raw: string): PublishedHealthSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new PublicationError('只读发布快照不是有效的 JSON', { cause: error });
  }

  if (!isRecord(value)
    || value.app !== 'vita-log-publication'
    || value.publicationSchemaVersion !== PUBLICATION_SCHEMA_VERSION
    || value.sourceSchemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new PublicationError('不支持的只读发布快照版本');
  }

  try {
    return createPublication(normalizeSnapshot(value.snapshot), value.publishedAt as string);
  } catch (error) {
    if (error instanceof PublicationError) throw error;
    throw new PublicationError('只读发布快照数据无效', { cause: error });
  }
}

export class PublishedHealthRepository implements HealthDataRepository {
  constructor(private readonly publication: PublishedHealthSnapshot) {}

  async load(): Promise<LoadResult> {
    return { snapshot: normalizeSnapshot(this.publication.snapshot), status: 'loaded' };
  }

  async commit(_snapshot: HealthSnapshot): Promise<void> {
    throw new StorageError('write-failed', '只读发布页面不允许修改数据');
  }

  async loadRecovery(): Promise<HealthSnapshot> {
    throw new StorageError('recovery-unavailable', '只读发布页面没有恢复快照');
  }
}

function validTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    throw new PublicationError(`${label}无效`);
  }
  const canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== canonical) {
    throw new PublicationError(`${label}无效`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
