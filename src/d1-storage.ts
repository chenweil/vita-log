import { normalizeSnapshot, type HealthSnapshot } from './domain';
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
  /**
   * No recovery endpoint is deployed in this mode; restoring a snapshot is
   * #06.1-05's work. Declaring it here is what keeps the page from enabling a
   * restore control that could only fail.
   */
  readonly keepsRecoveryPoint = false;

  private version: number | null = null;
  constructor(private readonly client: Fetcher = window) {}

  async load(): Promise<LoadResult> {
    // A failed reload must never leave an earlier editing version usable.
    this.version = null;
    const owner = await this.request('/api/owner-snapshot');
    if (owner.ok) {
      try {
        const data = await owner.json() as { snapshot: unknown; version: unknown };
        if (!Number.isSafeInteger(data.version) || Number(data.version) < 0) throw new Error('Invalid version');
        const snapshot = normalizeSnapshot(data.snapshot);
        this.version = Number(data.version);
        return { snapshot, status: 'loaded', scope: 'owner' };
      } catch (error) {
        throw new StorageError('database-unavailable', '健康数据服务返回了无法识别的内容，请稍后重试', { cause: error });
      }
    }
    // Only an explicitly absent/expired session selects the public projection.
    // An outage or malformed owner response cannot silently downgrade the read.
    if (owner.status !== 401) throw await this.errorFrom(owner);
    const response = await this.request('/api/snapshot');
    if (!response.ok) throw await this.errorFrom(response);
    try {
      // `projection` is the whole point of naming this: what the page holds now
      // is not the record the owner saves back.
      return { snapshot: toHealthSnapshot(parsePublicSnapshot(await response.text())), status: 'loaded', scope: 'projection' };
    } catch (error) {
      throw new StorageError('database-unavailable', '健康数据服务返回了无法识别的内容，请稍后重试', { cause: error });
    }
  }

  /** Save against the version of the complete snapshot last loaded or saved.
   * Session checks cannot advance this version: stale input remains stale until reload.
   * Public projections cannot be saved because they omit owner-only settings.
   */
  async commit(snapshot: HealthSnapshot): Promise<void> {
    if (!await this.session()) throw new StorageError('unauthorized', '编辑会话已失效，请重新登录');
    if (this.version === null) throw new StorageError('version-conflict', '请重新加载完整编辑快照；未提交输入已保留');
    const expectedVersion = this.version;
    let response: Response;
    try {
      response = await this.client.fetch('/api/snapshot', {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ snapshot, expectedVersion }),
      });
    } catch (error) {
      throw new StorageError('database-unavailable', '健康数据服务暂时不可用，请稍后重试', { cause: error });
    }
    if (!response.ok) throw await this.errorFrom(response);
    try {
      const saved = await response.json() as { version?: unknown };
      if (saved.version !== expectedVersion + 1) throw new Error('Invalid saved version');
      this.version = Number(saved.version);
    } catch (error) {
      // The write may have landed: reload before another save rather than guessing.
      this.version = null;
      throw new StorageError('database-unavailable', '健康数据服务返回了无法识别的内容，请重新加载', { cause: error });
    }
  }

  private async request(path: string): Promise<Response> {
    try {
      return await this.client.fetch(path, { credentials: 'same-origin', cache: 'no-store' });
    } catch (error) {
      throw new StorageError('database-unavailable', '健康数据服务暂时不可用，请稍后重试', { cause: error });
    }
  }

  /** The version last seen or last written, for a caller that wants to inspect it. */
  get currentVersion(): number | null {
    return this.version;
  }

  async loadRecovery(): Promise<HealthSnapshot> {
    throw new StorageError('recovery-unavailable', '公开读取模式没有恢复快照');
  }

  /** Check authorization only; session metadata must never refresh a stale version. */
  private async session(): Promise<boolean> {
    const response = await this.request('/api/session');
    if (!response.ok) throw await this.errorFrom(response);
    try {
      const state = await response.json() as { loggedIn?: unknown };
      return state.loggedIn === true;
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
