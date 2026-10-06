import { guardApiErrors, noStore, readJsonBody, requireSameOrigin, unauthorized, validationFailed, type FunctionContext } from '../_lib/api';
import { commitMigration } from '../_lib/migration';
import { D1UnavailableError } from '../_lib/d1-store';
import { addressKey, clientIp, consume, sessionKey, WRITE_ATTEMPTS } from '../_lib/rate-limit';
import { readSessionToken, resolveSession } from '../_lib/session';

const now = (): number => Date.now();

/**
 * The owner's confirmed first import of their local snapshot into D1.
 *
 * A separate route from the daily save on purpose. `PUT /api/snapshot` can only
 * UPDATE an existing row, so it cannot create the online source of truth — that
 * asymmetry is what stops a stray save from quietly replacing the migration with
 * an empty snapshot. This route is the one place that creates the row, and it
 * does so only after the same-origin check, a live session, and the
 * empty-database guard that lives inside the INSERT itself.
 *
 * A refused import answers `migration-conflict` and nothing else, so the caller
 * can tell "D1 already holds data and this would have overwritten it" apart from
 * "the database is down". Only the first is resolved by choosing a different
 * import strategy.
 */
export async function handleMigrate(context: FunctionContext): Promise<Response> {
  requireSameOrigin(context.request);

  const db = context.env.VITA_LOG_DB;
  // A session store that cannot answer is a 503, not a logout: telling the owner
  // their session expired while the database is down sends the page into a
  // re-login loop it can never finish.
  const session = await resolveSession(db, readSessionToken(context.request), now())
    .catch(() => { throw new D1UnavailableError('健康数据服务暂时不可用，请稍后重试'); });
  if (!session) throw unauthorized('编辑会话已失效，请重新登录');

  // A migration is a write and the most destructive one this app has, so it
  // spends the same budget a daily save does rather than a separate larger one.
  if (!consume(sessionKey(session.token), WRITE_ATTEMPTS, now()).allowed) throw unauthorized('保存过于频繁，请稍后重试', 429);
  if (!consume(addressKey(clientIp(context.request)), WRITE_ATTEMPTS, now()).allowed) throw unauthorized('保存过于频繁，请稍后重试', 429);

  const body = await readJsonBody(context.request);
  // The version the owner's preview reported. An empty D1 is version 0, and
  // anything else means the preview no longer describes this database.
  //
  // Only a real non-negative integer, or an absent field, is accepted. Running
  // the value through `Number()` first is what makes this dangerous: `Number('')`,
  // `Number(null)` and `Number([])` are all 0, which is the one value that
  // passes — so a malformed field would silently be treated as "the empty
  // database" instead of being refused. The empty-database guard inside the
  // INSERT is what actually protects the data; this check exists to fail loudly.
  if (body.expectedVersion !== undefined && (typeof body.expectedVersion !== 'number' || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0)) {
    throw validationFailed('迁移版本无效，请重新预览');
  }
  return noStore(await commitMigration(db, body.snapshot as never, body.expectedVersion as number ?? 0, now()), 200);
}

export const onRequestPost = (context: FunctionContext): Promise<Response> => guardApiErrors(() => handleMigrate(context));

/**
 * Dispatch by method.
 *
 * The method is checked before anything else so a GET cannot be answered by the
 * import path at all, rather than reaching the handler and failing later on a
 * missing body.
 */
export const onRequest = (context: FunctionContext): Promise<Response> => {
  if (context.request.method !== 'POST') {
    return Promise.resolve(noStore({ code: 'validation-failed', message: '迁移接口只接受 POST' }, 405));
  }
  return onRequestPost(context);
};