import { closeOwnerSession, guard } from './session';
import type { FunctionContext } from '../_lib/api';

/**
 * `POST /api/logout` — mirrors the self-hosted Node server, so the shared
 * `ServerEditorAuth` client can revoke a session against either backend.
 * Revocation is server-side, so an already-open page stops being able to write.
 */
export const onRequestPost = (context: FunctionContext): Promise<Response> => guard(() => closeOwnerSession(context));

export const onRequest = onRequestPost;
