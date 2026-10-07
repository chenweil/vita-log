import type { EditorAuth, UnlockResult } from './auth';
import { isRecord } from './domain';

interface Fetcher { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> }

/** What each kind of refusal says when the server did not say it itself. */
const DEFAULT_MESSAGES = {
  rejected: '账号或密码错误，未进入编辑模式',
  limited: '尝试过于频繁，请稍后再试',
  unavailable: '登录服务暂时不可用，请稍后重试',
} as const;

const UNAVAILABLE: UnlockResult = { outcome: 'unavailable', message: DEFAULT_MESSAGES.unavailable };

/**
 * Name what went wrong, from the HTTP status.
 *
 * Never from the body's `code`: both backends answer a rate limit with
 * `code: 'unauthorized'` (`server/api.ts:50`, `functions/api/session.ts:57`) —
 * the same code a wrong password gets. A body-first classifier would file "you
 * are being throttled" under "your password is wrong", which is the one repair
 * that cannot help.
 *
 * The server's own wording wins when it sent one: it knows the limit and the
 * retry window, and paraphrasing them would throw away the only number the
 * owner can act on.
 */
const classify = async (response: Response): Promise<UnlockResult> => {
  const outcome = response.status === 429 ? 'limited'
    : response.status === 401 || response.status === 400 ? 'rejected'
      : 'unavailable';
  const body = await response.json().catch(() => null) as { message?: unknown } | null;
  const message = typeof body?.message === 'string' && body.message.trim() ? body.message : DEFAULT_MESSAGES[outcome];
  return { outcome, message };
};

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
  async unlock(username: string, password: string): Promise<UnlockResult> {
    try {
      const session = await this.client.fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
      // A probe that cannot answer means the service is in trouble, which is a
      // different statement from "these credentials were refused" — and the
      // login POST below would have failed for the same reason.
      if (!session.ok) return await classify(session);
      const state: unknown = await session.json();
      // Both backends return a boolean flag and a numeric deadline; a logged-out
      // session has deadline 0. An invalid probe says nothing about the password.
      if (!isRecord(state) || typeof state.loggedIn !== 'boolean' || typeof state.until !== 'number' || !Number.isFinite(state.until)) return UNAVAILABLE;
      if (state.loggedIn) {
        if (state.until <= this.now()) return UNAVAILABLE;
        this.unlockedUntil = state.until;
        return { outcome: 'unlocked' };
      }
      if (state.until !== 0) return UNAVAILABLE;
      const response = await this.client.fetch('/api/login', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
      if (!response.ok) return await classify(response);
      const result: unknown = await response.json();
      // A 200 with a body we cannot read is not an unlocked session. Reporting
      // it as one closes the modal and sends the page off to reload as though it
      // held an owner session, which is the one thing this call must never
      // claim without evidence.
      if (!isRecord(result) || typeof result.until !== 'number' || !Number.isFinite(result.until) || result.until <= this.now()) return UNAVAILABLE;
      this.unlockedUntil = result.until;
      return { outcome: 'unlocked' };
      // A dropped connection, a timeout and an unreadable body all land here.
      // None of them is evidence about the password, so none of them may be
      // reported as evidence about the password.
    } catch { return UNAVAILABLE; }
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
