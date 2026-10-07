import { guardApiErrors, noStore, unauthorized, validationFailed, type FunctionContext } from '../_lib/api';
import { readAudit, type AuditKind } from '../_lib/audit';
import { readSessionToken, resolveSession } from '../_lib/session';

export const onRequestGet = (context: FunctionContext): Promise<Response> => guardApiErrors(async () => {
  if (!await resolveSession(context.env.VITA_LOG_DB, readSessionToken(context.request), Date.now())) throw unauthorized('审计读取需要本人登录');
  const query = new URL(context.request.url).searchParams;
  const kind = query.get('kind') ?? 'write';
  const cursor = query.get('before');
  if (!['write', 'backup', 'all'].includes(kind)) throw validationFailed('审计分类无效');
  if (cursor !== null && (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)) || Number(cursor) <= 0)) throw validationFailed('审计游标无效');
  return noStore(await readAudit(context.env.VITA_LOG_DB, cursor === null ? null : Number(cursor), kind as AuditKind), 200);
});
export const onRequest = (context: FunctionContext): Promise<Response> => context.request.method === 'GET'
  ? onRequestGet(context)
  : Promise.resolve(noStore({ code: 'validation-failed', message: '审计接口只接受 GET' }, 405));
