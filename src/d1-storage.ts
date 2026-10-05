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
  private version = 0;
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

  /**
   * Save a versioned snapshot through the owner's server session.
   *
   * The version is read from the session endpoint rather than from `load()`:
   * the public projection leaves it out on purpose, as internal storage
   * metadata, so an editing client has to ask for it where the request is
   * already authenticated. Reading it immediately before the write is also
   * what makes the conflict real — two tabs saving at once, one of them losing.
   *
   * Nothing local is discarded when the save is refused. A `version-conflict`
   * propagates with the server's own wording so the page can keep the owner's
   * unsubmitted input on screen and ask them to reload before retrying.
   */
  async commit(snapshot: HealthSnapshot): Promise<void> {
    const session = await this.session();
    if (!session.loggedIn) throw new StorageError('unauthorized', '编辑会话已失效，请重新登录');

    let response: Response;
    try {
      response = await this.client.fetch('/api/snapshot', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ snapshot, expectedVersion: session.version }),
      });
    } catch (error) {
      throw new StorageError('database-unavailable', '健康数据服务暂时不可用，请稍后重试', { cause: error });
    }

    if (!response.ok) throw await this.errorFrom(response);

    try {
      const saved = await response.json() as { version?: unknown };
      this.version = Number.isSafeInteger(saved.version) ? Number(saved.version) : session.version;
    } catch (error) {
      throw new StorageError('database-unavailable', '健康数据服务返回了无法识别的内容，请稍后重试', { cause: error });
    }
  }

  /** The version last seen or last written, for a caller that wants to inspect it. */
  get currentVersion(): number {
    return this.version;
  }

  async loadRecovery(): Promise<HealthSnapshot> {
    throw new StorageError('recovery-unavailable', '公开读取模式没有恢复快照');
  }

  /**
   * Ask the server whether this browser still holds an editing session, and
   * for the version its next write must carry.
   */
  private async session(): Promise<{ loggedIn: boolean; version: number }> {
    let response: Response;
    try {
      response = await this.client.fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
    } catch (error) {
      throw new StorageError('database-unavailable', '健康数据服务暂时不可用，请稍后重试', { cause: error });
    }
    if (!response.ok) throw await this.errorFrom(response);
    try {
      const state = await response.json() as { loggedIn?: unknown; version?: unknown };
      const version = Number(state.version);
      return {
        loggedIn: state.loggedIn === true,
        version: Number.isSafeInteger(version) && version >= 0 ? version : this.version,
      };
    } catch (error) {
      throw new StorageError('database-unavailable', '健康数据服务返回了无法识别的内容，请稍后重试', { cause: error });
    }
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
