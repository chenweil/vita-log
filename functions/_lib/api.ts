import { isRecord } from '../../src/domain';
import type { OwnerEnv } from './owner-credentials';
import type { D1DatabaseLike } from './d1-store';

/**
 * Shared request handling for the Pages Functions routes.
 *
 * Everything the spec pins as a stable contract lives here: the error codes,
 * the no-store header, and the same-origin requirement on writes. Keeping it
 * in one module is what stops the read route and the write route from
 * disagreeing about what "unauthorized" or "same origin" means.
 */

/** The stable codes from the spec. A route may not invent a sixth. */
export type ApiErrorCode = 'unauthorized' | 'version-conflict' | 'validation-failed' | 'database-unavailable' | 'migration-conflict';

export const API_ERROR_CODES: readonly ApiErrorCode[] = [
  'unauthorized', 'version-conflict', 'validation-failed', 'database-unavailable', 'migration-conflict',
];

export class ApiError extends Error {
  constructor(public readonly code: ApiErrorCode, message: string, public readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export const unauthorized = (message: string, status = 401): ApiError => new ApiError('unauthorized', message, status);
export const validationFailed = (message: string, status = 400): ApiError => new ApiError('validation-failed', message, status);
export const versionConflict = (message: string): ApiError => new ApiError('version-conflict', message, 409);

/** The subset of the Pages Functions context these routes read. */
export interface FunctionContext {
  request: Request;
  env: OwnerEnv & { VITA_LOG_DB?: D1DatabaseLike };
}

/**
 * Every response is `no-store`.
 *
 * "Refresh shows the latest save" is the product promise, and it does not hold
 * if an intermediary is free to keep an authenticated response. Applied to
 * failures too, so an error cannot be cached into something the owner does not
 * see.
 */
export const noStore = (body: unknown, status: number, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

/**
 * Require that a mutating request came from this origin.
 *
 * Three independent signals, because a cookie is attached automatically and one
 * check alone is a single point of failure:
 *
 * - `Origin` must be the request's own origin. A missing Origin is refused
 *   rather than assumed same-origin; a browser always sends it on a write.
 * - `Host` must match, so a forged Host cannot carry an otherwise-plausible
 *   Origin.
 * - `Sec-Fetch-Site: cross-site` is refused even if the two above agree.
 *
 * No CORS headers are ever emitted, so there is no cross-origin client to
 * negotiate with in the first place.
 */
export function requireSameOrigin(request: Request): void {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  if (origin !== url.origin) throw unauthorized('拒绝跨站写入请求', 403);

  const host = request.headers.get('host');
  if (host !== null && host !== url.host) throw unauthorized('拒绝跨站写入请求', 403);

  if (request.headers.get('sec-fetch-site') === 'cross-site') throw unauthorized('拒绝跨站写入请求', 403);
}

/** Parse a JSON body that is small enough to be a health snapshot. */
export async function readJsonBody(request: Request, maxBytes = 5 * 1024 * 1024): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    throw validationFailed('请求必须使用 application/json', 415);
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) throw validationFailed('请求超过 5 MiB 上限', 413);
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw validationFailed('请求不是有效 JSON');
  }
  if (!isRecord(value)) throw validationFailed('请求必须是 JSON 对象');
  return value;
}
