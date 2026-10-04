import type { EditorAuth } from './auth';

interface Fetcher { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> }
export class ServerEditorAuth implements EditorAuth {
  private unlockedUntil = 0;
  constructor(private readonly client: Fetcher = window, private readonly now: () => number = () => Date.now()) {}
  isUnlocked(): boolean { return this.unlockedUntil > this.now(); }
  async unlock(username: string, password: string): Promise<boolean> {
    try {
      const session = await this.client.fetch('/api/session', { credentials: 'same-origin' });
      const state = await session.json() as { configured: boolean; loggedIn: boolean; until: number };
      if (state.loggedIn && state.until > this.now()) { this.unlockedUntil = state.until; return true; }
      const endpoint = state.configured ? '/api/login' : '/api/setup';
      const response = await this.client.fetch(endpoint, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
      if (!response.ok) return false;
      const result = await response.json() as { until: number };
      this.unlockedUntil = result.until;
      return true;
    } catch { return false; }
  }
  lock(): void { this.unlockedUntil = 0; void this.client.fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); }
}
