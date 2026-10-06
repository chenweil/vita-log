import type { EditorAuth } from './auth';

interface Fetcher { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> }

/**
 * Drives an owner session against either backend, which expose the same three
 * endpoints: `GET /api/session`, `POST /api/login`, `POST /api/logout`.
 *
 * There is deliberately no first-run setup branch. A client that can fall back
 * to `/api/setup` holds an unauthenticated call to a route no deployment is
 * allowed to have: the Worker has no such route at all, and the self-hosted
 * server answers an unknown path with 401 from the session gate before its 404
 * fallthrough. So the fallback could never have worked, while quietly being the
 * thing that reintroduces the path. The first administrator is provisioned
 * offline: a Cloudflare Secret for the Worker, `npm run owner -- sqlite-set`
 * for the self-hosted store.
 */
export class ServerEditorAuth implements EditorAuth {
  private unlockedUntil = 0;
  constructor(
    private readonly client: Fetcher = window,
    private readonly now: () => number = () => Date.now(),
  ) {}
  canUnlock(): boolean { return true; }
  isUnlocked(): boolean { return this.unlockedUntil > this.now(); }
  async unlock(username: string, password: string): Promise<boolean> {
    try {
      const session = await this.client.fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
      const state = await session.json() as { loggedIn: boolean; until: number };
      if (state.loggedIn && state.until > this.now()) { this.unlockedUntil = state.until; return true; }
      const response = await this.client.fetch('/api/login', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
      if (!response.ok) return false;
      const result = await response.json() as { until: number };
      this.unlockedUntil = result.until;
      return true;
    } catch { return false; }
  }

  /**
   * Lock, and only claim it once the server agrees.
   *
   * The revocation is awaited and its status checked, because the cookie outlives
   * this call: if the request fails, the server-side session is still live for
   * the rest of its 30 minutes, and a page that had already hidden its controls
   * would be telling the owner they are safe when they are not. So the local
   * unlock is cleared on confirmation and left alone otherwise — an honest
   * "still unlocked" beats a locked-looking page with a live session.
   *
   * This never rejects, so a caller that fires and forgets cannot produce an
   * unhandled rejection. Surfacing the failure to the owner is UI work, which
   * 06.1-04 owns.
   */
  async lock(): Promise<void> {
    try {
      const response = await this.client.fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
      if (!response.ok) return;
      this.unlockedUntil = 0;
    } catch { /* the session is still live, so the page must not pretend otherwise */ }
  }
}
