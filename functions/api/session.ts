import { ApiError, noStore, readJsonBody, requireSameOrigin, unauthorized, type ApiErrorCode, type FunctionContext } from '../_lib/api';
import { accountKey, addressKey, clientIp, consume, LOGIN_ATTEMPTS, reset } from '../_lib/rate-limit';
import { verifyOwnerCredentials } from '../_lib/owner-credentials';
import { D1UnavailableError, readHealthStateVersion } from '../_lib/d1-store';
import {
  clearSessionCookie, openSession, randomSessionToken, readSessionToken, resolveSession, revokeSession,
  SessionStoreError, sessionCookie,
} from '../_lib/session';

/**
 * The owner session endpoint: read it, open it, close it.
 *
 * There is no setup or password-reset route here, and that is deliberate. The
 * first administrator is provisioned offline from a Cloudflare Secret (see
 * owner-credentials.ts), so nothing a visitor can send can create an account.
 * `GET` is the only method that touches no credential, and it reports just
 * enough for the page to decide whether to show the editor.
 */

const now = (): number => Date.now();

/** One wording for every limiter, so the owner is never told which one tripped. */
const TOO_MANY_ATTEMPTS = '尝试次数过多，请一分钟后重试';

/**
 * Report the live session, if any. Reveals no credential material.
 *
 * `version` rides along so the owner can save without a second round trip: the
 * public projection deliberately omits it as internal storage metadata, so the
 * authenticated response is where an editing client learns the value its
 * `expectedVersion` must carry. It is a monotonic counter, never health data.
 *
 * A session store that cannot answer is a 503 rather than "logged out", so the
 * page can say the service is unavailable instead of quietly dropping the
 * editor into a read-only state.
 */
export async function readSession(context: FunctionContext): Promise<Response> {
  const db = context.env.VITA_LOG_DB;
  const session = await guardSession(() => resolveSession(db, readSessionToken(context.request), now()));
  if (!session) return noStore({ loggedIn: false, until: 0, version: 0 }, 200);
  return noStore({ loggedIn: true, until: session.expiresAt, version: await guardSession(() => readHealthStateVersion(db)) }, 200);
}

/**
 * Exchange the owner's password for a session cookie.
 *
 * The rate limit runs before the KDF, so an account that is already locked out
 * costs no PBKDF2 iterations. Both the account and the address are counted: the
 * address stops one attacker spraying across accounts, and the account stops
 * one attacker rotating addresses.
 */
export async function openOwnerSession(context: FunctionContext): Promise<Response> {
  requireSameOrigin(context.request);
  const ip = clientIp(context.request);
  const body = await readJsonBody(context.request);
  const account = accountKey(typeof body.username === 'string' ? body.username : '');

  if (!consume(account, LOGIN_ATTEMPTS, now()).allowed) throw unauthorized(TOO_MANY_ATTEMPTS, 429);
  if (!consume(addressKey(ip), LOGIN_ATTEMPTS, now()).allowed) throw unauthorized(TOO_MANY_ATTEMPTS, 429);

  if (!await verifyOwnerCredentials(context.env, body.username, body.password)) throw unauthorized('账号或密码错误');

  // A correct password restores the budget it spent, so a slip of the fingers
  // cannot lock the owner out of their own site.
  reset(account);
  reset(addressKey(ip));

  const db = context.env.VITA_LOG_DB;
  if (!db) throw new ApiError('database-unavailable', '健康数据服务暂时不可用，请稍后重试', 503);
  const session = await openSession(db, randomSessionToken(), now());
  return noStore({ loggedIn: true, until: session.expiresAt }, 200, { 'set-cookie': sessionCookie(session.token) });
}

/**
 * Revoke the session server-side, so an open page stops being able to write.
 *
 * A store that cannot answer is a 503. Saying "logged out" while the row
 * survived would tell the owner their editor rights are gone when they are not.
 */
export async function closeOwnerSession(context: FunctionContext): Promise<Response> {
  requireSameOrigin(context.request);
  await guardSession(() => revokeSession(context.env.VITA_LOG_DB, readSessionToken(context.request), now()));
  return noStore({ loggedIn: false, until: 0 }, 200, { 'set-cookie': clearSessionCookie() });
}

export const onRequestGet = (context: FunctionContext): Promise<Response> => guard(() => readSession(context));
export const onRequestPost = (context: FunctionContext): Promise<Response> => guard(() => openOwnerSession(context));
export const onRequestDelete = (context: FunctionContext): Promise<Response> => guard(() => closeOwnerSession(context));

/** Any other method is refused here rather than falling through to a platform default. */
export const onRequest = (context: FunctionContext): Promise<Response> => {
  switch (context.request.method) {
    case 'GET': return guard(() => readSession(context));
    case 'POST': return guard(() => openOwnerSession(context));
    case 'DELETE': return guard(() => closeOwnerSession(context));
    default: return Promise.resolve(noStore({ code: 'validation-failed', message: '不支持的请求方法' } satisfies { code: ApiErrorCode; message: string }, 405));
  }
};

/** Map every failure onto one of the stable codes with a no-store body. */
export async function guard(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError) return noStore({ code: error.code, message: error.message }, error.status);
    return noStore({ code: 'database-unavailable', message: '健康数据服务暂时不可用，请稍后重试' }, 503);
  }
}

/** Turn an unreachable session or snapshot store into a 503, not a silent logout. */
async function guardSession<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SessionStoreError || error instanceof D1UnavailableError) {
      throw new ApiError('database-unavailable', '健康数据服务暂时不可用，请稍后重试', 503);
    }
    throw error;
  }
}
