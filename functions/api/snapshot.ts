import { createPublicSnapshot } from '../../src/public-snapshot';
import { D1NotInitializedError, readHealthState, type D1DatabaseLike } from '../_lib/d1-store';

/** The subset of the Pages Functions context this route reads. */
export interface FunctionContext {
  request: Request;
  env: { VITA_LOG_DB?: D1DatabaseLike };
}

/** Health responses are never cached: "refresh shows the latest save" depends on it. */
const noStore = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/**
 * Anonymous public read. No credential is consulted, so a visitor always gets
 * the current saved dashboard, and every failure mode resolves to one stable
 * code instead of an empty snapshot.
 */
export async function handlePublicSnapshot(context: FunctionContext): Promise<Response> {
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

export const onRequestGet = (context: FunctionContext): Promise<Response> => handlePublicSnapshot(context);

/**
 * This route is read-only. Owner's writes arrive with a server session in
 * 06.1-02a, so until then every non-GET method is refused here rather than
 * falling through to a non-JSON platform default. The refusal keeps the same
 * stable body and no-store header as the read path.
 */
export const onRequest = (context: FunctionContext): Promise<Response> => {
  if (context.request.method === 'GET') return handlePublicSnapshot(context);
  return Promise.resolve(noStore({ code: 'validation-failed', message: '公开读取接口只接受 GET' }, 405));
};
