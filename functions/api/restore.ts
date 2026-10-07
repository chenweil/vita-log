import { guardApiErrors, noStore, type FunctionContext } from '../_lib/api';
import { handleOwnerSave } from './snapshot';

/** The offline recovery command persists the safety copy before calling here. */
export const onRequestPost = (context: FunctionContext): Promise<Response> => guardApiErrors(() => handleOwnerSave(context, 'restore'));
export const onRequest = (context: FunctionContext): Promise<Response> => context.request.method === 'POST'
  ? onRequestPost(context)
  : Promise.resolve(noStore({ code: 'validation-failed', message: '恢复接口只接受 POST' }, 405));
