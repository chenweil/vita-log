import { ApiError, noStore, unauthorized, type FunctionContext } from '../_lib/api';
import { D1NotInitializedError, readOwnerHealthState } from '../_lib/d1-store';
import { readSessionToken, resolveSession } from '../_lib/session';

/** Full editing snapshot and its version; never served without a live session. */
export async function onRequest(context: FunctionContext): Promise<Response> {
  if (context.request.method !== 'GET') return noStore({ code: 'validation-failed', message: '编辑读取接口只接受 GET' }, 405);
  try {
    const session = await resolveSession(context.env.VITA_LOG_DB, readSessionToken(context.request), Date.now());
    if (!session) throw unauthorized('编辑会话已失效，请重新登录');
    return noStore(await readOwnerHealthState(context.env.VITA_LOG_DB), 200);
  } catch (error) {
    if (error instanceof ApiError) return noStore({ code: error.code, message: error.message }, error.status);
    return noStore({ code: 'database-unavailable', message: error instanceof D1NotInitializedError ? error.message : '健康数据服务暂时不可用，请稍后重试' }, 503);
  }
}
