import type { D1DatabaseLike } from './d1-store';
import { toHex } from './hex';

/**
 * Owner edit sessions, stored in D1 alongside the health snapshot.
 *
 * A Pages Function isolate is ephemeral and two consecutive requests are not
 * guaranteed to reach the same one, so a session held in a Worker global would
 * make a valid login randomly fail on the next write, and could not be revoked
 * across isolates. D1 is already the online source of truth here, so a session
 * is a row in it: the 30-minute absolute expiry and the immediate revocation on
 * logout are then properties of the row, visible to every isolate at once.
 */

export const SESSION_COOKIE = 'vita-log-session';

/** 30 minutes, absolute. */
export const SESSION_TTL_MS = 30 * 60 * 1000;
export const SESSION_MAX_AGE_SECONDS = SESSION_TTL_MS / 1000;

export const SESSION_SELECT = 'SELECT expires_at FROM owner_session WHERE token_hash = ?';
export const SESSION_INSERT = 'INSERT INTO owner_session (token_hash, expires_at) VALUES (?, ?)';
export const SESSION_DELETE = 'DELETE FROM owner_session WHERE token_hash = ?';
/** Reclaim rows whose 30 minutes are up; they are dead weight forever otherwise. */
export const SESSION_PRUNE = 'DELETE FROM owner_session WHERE expires_at <= ?';

/**
 * Cookie attributes, fixed.
 *
 * `HttpOnly` keeps the session out of reach of script on the page, `Secure`
 * keeps it off any plaintext hop, and `SameSite=Strict` means the browser will
 * not attach it to a cross-site request at all. The Path is narrowed to the API
 * so a static asset request never carries it.
 */
export function sessionCookie(token: string, maxAgeSeconds = SESSION_MAX_AGE_SECONDS): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=${maxAgeSeconds}`;
}

/** Expire the cookie immediately. Same attributes, so the browser replaces it. */
export const clearSessionCookie = (): string => sessionCookie('', 0);

/** Read the session token from a request's Cookie header, or '' when absent. */
export function readSessionToken(request: Request): string {
  const header = request.headers.get('cookie');
  if (!header) return '';
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === SESSION_COOKIE) return part.slice(separator + 1).trim();
  }
  return '';
}

export function randomSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/**
 * Store the hash of the token, not the token.
 *
 * A row read out of D1 is then useless to whoever holds it: they would still
 * need the cookie value that was never written down. It also means the session
 * table can be inspected without producing a live credential.
 */
export async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return toHex(new Uint8Array(digest));
}

export class SessionStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SessionStoreError';
  }
}

export interface ActiveSession {
  token: string;
  expiresAt: number;
}

/**
 * Open a session and return its expiry.
 *
 * Absolute expiry: the deadline is fixed here and no later request extends it,
 * so a tab left open in the background still loses its session on schedule.
 */
export async function openSession(db: D1DatabaseLike, token: string, now: number): Promise<ActiveSession> {
  const expiresAt = now + SESSION_TTL_MS;
  try {
    await db.prepare(SESSION_INSERT).bind(await hashSessionToken(token), expiresAt).run();
  } catch (error) {
    throw new SessionStoreError('无法创建编辑会话', { cause: error });
  }
  return { token, expiresAt };
}

/**
 * Resolve a request's session, or null when there is no live one.
 *
 * A missing cookie, an unknown token and an expired token are all null: the
 * requester simply has no edit rights.
 *
 * A *broken* store is different, and deliberately raises instead. Reporting an
 * unreachable D1 as "not logged in" would tell the owner their session expired
 * when it did not, and would push the page into a re-login loop against a
 * database that is not answering. The caller turns this into a 503.
 */
export async function resolveSession(db: D1DatabaseLike | undefined, token: string, now: number): Promise<ActiveSession | null> {
  if (!token) return null;
  if (!db) throw new SessionStoreError('D1 数据库绑定缺失');
  let row: { expires_at?: unknown } | null;
  try {
    row = await db.prepare(SESSION_SELECT).bind(await hashSessionToken(token)).first<{ expires_at?: unknown }>();
  } catch (error) {
    throw new SessionStoreError('无法查询编辑会话', { cause: error });
  }
  const expiresAt = Number(row?.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  return { token, expiresAt };
}

/**
 * Revoke a session immediately, so an open page cannot keep writing.
 *
 * A failure here is raised rather than swallowed. Reporting a successful logout
 * when the row survived would tell the owner their session is gone while it
 * stays usable for the rest of its 30 minutes — the opposite of what
 * acceptance item 2 promises. The cookie is cleared either way, but the caller
 * is told the truth about the server side.
 *
 * Lapsed rows are pruned on the way past. Nothing else would ever remove them,
 * so the table would otherwise grow one dead row per login forever.
 */
export async function revokeSession(db: D1DatabaseLike | undefined, token: string, now: number): Promise<void> {
  if (!token) return;
  if (!db) throw new SessionStoreError('D1 数据库绑定缺失');
  try {
    await db.prepare(SESSION_PRUNE).bind(now).run();
    await db.prepare(SESSION_DELETE).bind(await hashSessionToken(token)).run();
  } catch (error) {
    throw new SessionStoreError('无法撤销编辑会话', { cause: error });
  }
}
