import { guardApiErrors, noStore, unauthorized, type FunctionContext } from '../_lib/api';
import { readOwnerHealthState } from '../_lib/d1-store';
import { readSessionToken, resolveSession } from '../_lib/session';
import { recordBackup } from '../_lib/audit';

/** Complete health data only: neither credentials nor session rows are exported. */
export const onRequestGet = (context: FunctionContext): Promise<Response> => guardApiErrors(async () => {
  const session = await resolveSession(context.env.VITA_LOG_DB, readSessionToken(context.request), Date.now());
  if (!session) throw unauthorized('备份需要本人登录');
  const backup = { ...await readOwnerHealthState(context.env.VITA_LOG_DB), exportedAt: new Date().toISOString() };
  await recordBackup(context.env.VITA_LOG_DB, backup.version, backup.exportedAt);
  return noStore(backup, 200);
});

export const onRequest = (context: FunctionContext): Promise<Response> => context.request.method === 'GET'
  ? onRequestGet(context)
  : Promise.resolve(noStore({ code: 'validation-failed', message: '备份接口只接受 GET' }, 405));
