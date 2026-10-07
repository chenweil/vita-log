import { createPublicSnapshot } from '../../src/public-snapshot';
import {
  commitHealthState, D1NotInitializedError, D1UnavailableError, HealthStateVersionConflict, readHealthState,
} from '../_lib/d1-store';
import { ApiError, guardApiErrors, noStore, readJsonBody, requireSameOrigin, unauthorized, versionConflict, type FunctionContext } from '../_lib/api';
import { addressKey, clientIp, consume, sessionKey, WRITE_ATTEMPTS } from '../_lib/rate-limit';
import { readSessionToken, resolveSession } from '../_lib/session';
import type { AuditOperation } from '../_lib/audit';

/** The subset of the Pages Functions context this route reads. */
export type SnapshotContext = FunctionContext;

const now = (): number => Date.now();

/** One wording for the write limiter, so it never reveals which key tripped. */
const TOO_MANY_WRITES = '保存过于频繁，请稍后重试';

/**
 * Anonymous public read. No credential is consulted, so a visitor always gets
 * the current saved dashboard, and every failure mode resolves to one stable
 * code instead of an empty snapshot.
 */
export async function handlePublicSnapshot(context: SnapshotContext): Promise<Response> {
  try {
    return noStore(createPublicSnapshot(await readHealthState(context.env.VITA_LOG_DB)), 200);
  } catch (error) {
    // An empty D1 keeps its own wording so the owner can tell "not imported
    // yet" apart from an outage; both stay 503 so neither reads as empty data.
    if (error instanceof D1NotInitializedError) {
      return noStore({ code: 'database-unavailable', message: error.message }, 503);
    }
    return noStore({ code: 'database-unavailable', message: '健康数据服务暂时不可用，请稍后重试' }, 503);
  }
}

export const onRequestGet = (context: SnapshotContext): Promise<Response> => handlePublicSnapshot(context);

/**
 * The owner's versioned save.
 *
 * Authorization is re-derived from the request every time: the session is
 * resolved server-side, and the same-origin requirement is checked before the
 * body is even read. Nothing here trusts what the page believes about its own
 * state, so hiding the controls is not what protects the data.
 */
export async function handleOwnerSave(context: SnapshotContext, operation: Extract<AuditOperation, 'save' | 'restore'> = 'save'): Promise<Response> {
  // Same-origin first: a cross-site write is refused before it can spend a
  // PBKDF2 round or a database write.
  requireSameOrigin(context.request);

  const db = context.env.VITA_LOG_DB;
  // A session store that cannot answer is a 503, not a logout: telling the
  // owner their session expired when the database is simply down would send
  // the page into a re-login loop it can never finish.
  const session = await resolveSession(db, readSessionToken(context.request), now())
    .catch(() => { throw new ApiError('database-unavailable', '健康数据服务暂时不可用，请稍后重试', 503); });
  if (!session) throw unauthorized('编辑会话已失效，请重新登录');

  // Both dimensions the spec names for the write path. The session key stops
  // one editor from flooding; the address key still binds if the WAF layer in
  // front is not yet configured for this route.
  if (!consume(sessionKey(session.token), WRITE_ATTEMPTS, now()).allowed) throw unauthorized(TOO_MANY_WRITES, 429);
  if (!consume(addressKey(clientIp(context.request)), WRITE_ATTEMPTS, now()).allowed) throw unauthorized(TOO_MANY_WRITES, 429);

  const body = await readJsonBody(context.request);
  const expectedVersion = Number(body.expectedVersion);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
    throw versionConflict('数据已更新，请重新加载；未提交输入已保留');
  }

  try {
    const saved = await commitHealthState(db, body.snapshot as never, expectedVersion, now(), operation);
    return noStore(saved, 200);
  } catch (error) {
    if (error instanceof HealthStateVersionConflict) throw versionConflict(error.message);
    // An empty D1 has no row to update. The first import is a migration, which
    // 06.1-03 owns, so a save against an uninitialized database is refused here
    // rather than silently creating one.
    if (error instanceof D1UnavailableError) throw new ApiError('database-unavailable', '健康数据保存失败，未提交输入已保留', 503);
    throw error;
  }
}

export const onRequestPut = (context: SnapshotContext): Promise<Response> => guardApiErrors(() => handleOwnerSave(context));

/**
 * Dispatch by method.
 *
 * The non-GET methods that are not a save are refused explicitly. A migration,
 * a clear or a backup is a separate, separately authorized operation — the
 * migration lives on `/api/migrate` — so they get a stable refusal rather than
 * a platform default with no code and no no-store header.
 */
export const onRequest = (context: SnapshotContext): Promise<Response> => {
  const method = context.request.method;
  if (method === 'GET') return handlePublicSnapshot(context);
  if (method === 'PUT') return guardApiErrors(() => handleOwnerSave(context));
  return Promise.resolve(noStore({ code: 'validation-failed', message: '健康数据接口只接受 GET 和 PUT' }, 405));
};
