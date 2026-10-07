import { guardApiErrors, noStore, unauthorized, type FunctionContext } from '../_lib/api';
import { readAudit } from '../_lib/audit';
import { readSessionToken, resolveSession } from '../_lib/session';

export const onRequestGet = (context: FunctionContext): Promise<Response> => guardApiErrors(async () => {
  if (!await resolveSession(context.env.VITA_LOG_DB, readSessionToken(context.request), Date.now())) throw unauthorized('审计读取需要本人登录');
  return noStore({ events: await readAudit(context.env.VITA_LOG_DB) }, 200);
});
export const onRequest = (context: FunctionContext): Promise<Response> => context.request.method === 'GET'
  ? onRequestGet(context)
  : Promise.resolve(noStore({ code: 'validation-failed', message: '审计接口只接受 GET' }, 405));
