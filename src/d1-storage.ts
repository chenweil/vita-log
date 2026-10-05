import { type HealthSnapshot } from './domain';
import { parsePublicSnapshot, toHealthSnapshot } from './public-snapshot';
import { StorageError, type HealthDataRepository, type LoadResult } from './storage';

interface Fetcher { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> }

/** Error codes the server is allowed to report back to this reader. */
const SERVER_ERROR_CODES = new Set<StorageError['code']>([
  'unauthorized', 'version-conflict', 'validation-failed', 'database-unavailable', 'migration-conflict', 'recovery-unavailable',
]);

/**
 * The online source of truth for the Cloudflare deployment: the D1 snapshot
 * read back through the same-origin Pages Function.
 *
 * It is deliberately fail-closed. Every failure — transport, non-OK status, or
 * an unreadable body — raises a StorageError so the page can say the service is
 * unavailable. It never falls back to a previous cache, the local SQLite copy,
 * or an empty snapshot, because all three would be indistinguishable from a
 * visitor having no health data at all.
 */
export class D1HealthRepository implements HealthDataRepository {
  constructor(private readonly client: Fetcher = window) {}

  async load(): Promise<LoadResult> {
    let response: Response;
    try {
      response = await this.client.fetch('/api/snapshot', { credentials: 'same-origin', cache: 'no-store' });
    } catch (error) {
      throw new StorageError('database-unavailable', '健康数据服务暂时不可用，请稍后重试', { cause: error });
    }

    if (!response.ok) throw await this.errorFrom(response);

    const raw = await response.text();
    try {
      return { snapshot: toHealthSnapshot(parsePublicSnapshot(raw)), status: 'loaded' };
    } catch (error) {
      throw new StorageError('database-unavailable', '健康数据服务返回了无法识别的内容，请稍后重试', { cause: error });
    }
  }

  /** Writes arrive with the owner's server session in 06.1-02a; until then this reader stays read-only. */
  async commit(_snapshot: HealthSnapshot): Promise<void> {
    throw new StorageError('write-failed', '当前是只读公开读取模式，尚未开放服务端保存');
  }

  async loadRecovery(): Promise<HealthSnapshot> {
    throw new StorageError('recovery-unavailable', '公开读取模式没有恢复快照');
  }

  private async errorFrom(response: Response): Promise<StorageError> {
    let message = '健康数据服务暂时不可用，请稍后重试';
    let code: StorageError['code'] = 'database-unavailable';
    try {
      const body = await response.json() as { code?: unknown; message?: unknown };
      if (typeof body.message === 'string' && body.message) message = body.message;
      if (typeof body.code === 'string' && SERVER_ERROR_CODES.has(body.code as StorageError['code'])) code = body.code as StorageError['code'];
    } catch { /* keep the stable default message rather than surfacing a parse error */ }
    return new StorageError(code, message);
  }
}
