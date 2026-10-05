import { openOwnerSession, guard } from './session';
import type { FunctionContext } from '../_lib/api';

/**
 * `POST /api/login` — the self-hosted Node server exposes this exact path, and
 * the shared `ServerEditorAuth` client calls it for both backends. Without this
 * route the Cloudflare deployment would 404 on every login while the client
 * tests still passed, because they only ever checked that the client agreed
 * with itself.
 *
 * It is the same handler as `POST /api/session`, with the same guarantees: no
 * setup, no registration, no password reset, and the same-origin requirement.
 */
export const onRequestPost = (context: FunctionContext): Promise<Response> => guard(() => openOwnerSession(context));

export const onRequest = onRequestPost;
