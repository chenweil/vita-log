import type { EditorAuth } from './auth';

interface Fetcher { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> }

export interface ServerAuthOptions {
  /**
   * Whether the deployment exposes a public first-run setup route.
   *
   * The self-hosted Node server does, and it is how its owner account is
   * created. The Cloudflare deployment must not: there, the credential comes
   * from a Cloudflare Secret and no request can create an account, so falling
   * back to /api/setup would be an unauthenticated call to a route that does
   * not exist. Making it an explicit option keeps that boundary a decision
   * rather than an accident of which 404 came back.
   */
  allowSetup?: boolean;
}

export class ServerEditorAuth implements EditorAuth {
  private unlockedUntil = 0;
  constructor(
    private readonly client: Fetcher = window,
    private readonly now: () => number = () => Date.now(),
    private readonly options: ServerAuthOptions = {},
  ) {}
  isUnlocked(): boolean { return this.unlockedUntil > this.now(); }
  async unlock(username: string, password: string): Promise<boolean> {
    try {
      const session = await this.client.fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
      const state = await session.json() as { configured?: boolean; loggedIn: boolean; until: number };
      if (state.loggedIn && state.until > this.now()) { this.unlockedUntil = state.until; return true; }
      const endpoint = this.options.allowSetup === false || state.configured !== false ? '/api/login' : '/api/setup';
      const response = await this.client.fetch(endpoint, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
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
