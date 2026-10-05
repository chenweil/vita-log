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
  lock(): void { this.unlockedUntil = 0; void this.client.fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); }
}
