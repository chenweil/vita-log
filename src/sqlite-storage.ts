import { normalizeSnapshot, type HealthSnapshot } from './domain';
import { StorageError, type HealthDataRepository, type LoadResult } from './storage';

interface SqliteLoadResponse { snapshot: HealthSnapshot; version: number; empty: boolean }
export interface SqliteMigrationPreview { source: string; empty: boolean; summary: { total: number; firstDate: string | null; lastDate: string | null; counts: Record<string, number>; settings: { name: string; heightCm: number; targetWeightKg: number } } }
interface Fetcher { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> }

export class SqliteHealthRepository implements HealthDataRepository {
  /** Every server-side write keeps the previous payload in its `recovery` column. */
  readonly keepsRecoveryPoint = true;

  private version = 0;
  private loaded = false;
  constructor(private readonly client: Fetcher = window) {}
  async load(): Promise<LoadResult> {
    const response = await this.client.fetch('/api/snapshot', { credentials: 'same-origin' });
    const data = await readJson<SqliteLoadResponse>(response);
    this.version = data.version;
    this.loaded = true;
    return { snapshot: normalizeSnapshot(data.snapshot), status: data.empty ? 'new' : 'loaded', scope: 'owner' };
  }
  async commit(snapshot: HealthSnapshot): Promise<void> {
    if (!this.loaded) await this.load();
    const response = await this.client.fetch('/api/snapshot', {
      method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snapshot, expectedVersion: this.version }),
    });
    const data = await readJson<SqliteLoadResponse>(response);
    this.version = data.version;
  }
  async loadRecovery(): Promise<HealthSnapshot> {
    const response = await this.client.fetch('/api/recovery', { credentials: 'same-origin' });
    const data = await readJson<{ snapshot: HealthSnapshot }>(response);
    return normalizeSnapshot(data.snapshot);
  }
  async migrate(snapshot: HealthSnapshot): Promise<void> {
    const response = await this.client.fetch('/api/migrate', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snapshot, expectedVersion: this.version }),
    });
    const data = await readJson<SqliteLoadResponse>(response);
    this.version = data.version;
    this.loaded = true;
  }
  async previewMigration(snapshot: HealthSnapshot): Promise<SqliteMigrationPreview> {
    const response = await this.client.fetch('/api/migration-preview', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshot }),
    });
    return readJson<SqliteMigrationPreview>(response);
  }
  async backup(): Promise<string> {
    const response = await this.client.fetch('/api/backups', { method: 'POST', credentials: 'same-origin' });
    const data = await readJson<{ name: string }>(response);
    return data.name;
  }
  async listBackups(): Promise<Array<{ name: string; createdAt: string; summary: { total: number; firstDate: string | null; lastDate: string | null; settings: { name: string; heightCm: number; targetWeightKg: number } } }>> {
    const response = await this.client.fetch('/api/backups', { credentials: 'same-origin' });
    return readJson(response);
  }
  async restore(name: string): Promise<void> {
    const response = await this.client.fetch('/api/restore', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, expectedVersion: this.version }),
    });
    const data = await readJson<SqliteLoadResponse>(response);
    this.version = data.version;
  }
}

async function readJson<T>(response: Response): Promise<T> {
  let value: unknown;
  try { value = await response.json(); } catch (error) { throw new StorageError('read-failed', 'SQLite 服务返回了无效响应', { cause: error }); }
  if (!response.ok) {
    const data = value as { code?: string; message?: string };
    const code = data.code === 'version-conflict' || data.code === 'unauthorized' || data.code === 'migration-conflict' || data.code === 'backup-failed' || data.code === 'validation-failed' || data.code === 'database-unavailable' || data.code === 'recovery-unavailable' ? data.code : 'read-failed';
    throw new StorageError(code, data.message ?? 'SQLite 服务请求失败');
  }
  return value as T;
}
