import { guardApiErrors, noStore, readJsonBody, requireSameOrigin, unauthorized, validationFailed, type FunctionContext } from '../_lib/api';
import { previewMigration } from '../_lib/migration';
import { D1UnavailableError } from '../_lib/d1-store';
import { readSessionToken, resolveSession } from '../_lib/session';

const now = (): number => Date.now();

/**
 * What an import would bring, before the owner confirms anything.
 *
 * Gated like a write because it accepts and parses a full snapshot and reports
 * on the online database — but it is not one: `previewMigration` performs no
 * write at all, so calling this leaves D1 exactly as it was. That is what makes
 * "nothing is imported until the owner confirms" true by construction rather
 * than by the route choosing not to save.
 *
 * It also reports whether D1 is currently empty. A preview against a populated
 * D1 is not an error here — the owner is entitled to see what would happen — but
 * it does mean the confirm that follows will be refused.
 */
export async function handleMigrationPreview(context: FunctionContext): Promise<Response> {
  requireSameOrigin(context.request);

  const db = context.env.VITA_LOG_DB;
  const session = await resolveSession(db, readSessionToken(context.request), now())
    .catch(() => { throw new D1UnavailableError('健康数据服务暂时不可用，请稍后重试'); });
  if (!session) throw unauthorized('编辑会话已失效，请重新登录');

  const body = await readJsonBody(context.request);
  // The source is a label the owner reads back in the preview, so it is length
  // bounded rather than accepted verbatim into the response.
  const source = typeof body.source === 'string' && body.source.trim() ? body.source.trim().slice(0, 64) : '本机快照';
  if (typeof body.source === 'string' && body.source.length > 64) throw validationFailed('迁移来源名称过长');

  return noStore(await previewMigration(db, body.snapshot as never, source), 200);
}

export const onRequestPost = (context: FunctionContext): Promise<Response> => guardApiErrors(() => handleMigrationPreview(context));

/** Dispatch by method; a GET must never reach the preview handler. */
export const onRequest = (context: FunctionContext): Promise<Response> => {
  if (context.request.method !== 'POST') {
    return Promise.resolve(noStore({ code: 'validation-failed', message: '迁移预览接口只接受 POST' }, 405));
  }
  return onRequestPost(context);
};