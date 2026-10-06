import * as ownerSnapshotRoute from '../../functions/api/owner-snapshot';
import * as sessionRoute from '../../functions/api/session';
import * as loginRoute from '../../functions/api/login';
import * as logoutRoute from '../../functions/api/logout';
import * as snapshotRoute from '../../functions/api/snapshot';
import * as migrateRoute from '../../functions/api/migrate';
import * as migrationPreviewRoute from '../../functions/api/migration-preview';
import type { FunctionContext } from '../../functions/_lib/api';
import type { D1DatabaseLike } from '../../functions/_lib/d1-store';
import { clearRateLimits } from '../../functions/_lib/rate-limit';
import { SqliteD1 } from './sqlite-d1';

/**
 * A browser that talks to the real Pages Functions.
 *
 * The point of this double is that it is *only* a browser. It routes each
 * same-origin URL to the same handler Cloudflare would invoke, over a real
 * SQLite standing in for D1. The client under test, the route handlers, the
 * SQL, the schema and the session code are all the shipped ones.
 *
 * That matters because the alternative — replaying queued responses — has
 * already produced one false green in this project: a fake applied an UPDATE in
 * JavaScript, including a `version + 1` the production statement never performs,
 * so a write path that could never detect a conflict passed every test. Here a
 * route that forgets to authorize is refused by the route, not by the double.
 *
 * What it does model, because a real browser does it and the server depends on
 * it: the cookie jar, and the `Origin`/`Host` a browser attaches to a same-origin
 * write. Both are part of the authorization contract — `requireSameOrigin`
 * refuses a request without them, so a double that omitted them would test a
 * branch production never takes.
 */
export const ORIGIN = 'https://vita-log.pages.dev';

type MethodHandler = (context: FunctionContext) => Promise<Response>;
type RouteModule = Record<string, unknown>;

/**
 * Cloudflare's own dispatch rule: the method-specific export wins, and
 * `onRequest` is the fallback.
 *
 * This is not a detail. Every write route here exports `onRequestPut` or
 * `onRequestPost` *as well as* `onRequest`, and today the two happen to call the
 * same underlying function. Calling only `onRequest` would therefore have
 * produced a green suite while `onRequestPut` — the export a real PUT actually
 * reaches — could be replaced with something unauthorized. Review confirmed it:
 * gutting `onRequestPut` left this file's suite fully green. Dispatching the way
 * the platform does is what makes "the page cannot write" a statement about the
 * deployed code rather than about one of two entry points into it.
 */
const dispatch = (route: RouteModule, method: string): MethodHandler => {
  const specific = route[`onRequest${method.charAt(0)}${method.slice(1).toLowerCase()}`];
  const chosen = typeof specific === 'function' ? specific : route.onRequest;
  if (typeof chosen !== 'function') throw new Error(`route has no handler for ${method}`);
  return chosen as MethodHandler;
};

export interface CloudflareRuntimeOptions {
  db?: SqliteD1;
  username?: string;
  /** The encoded `pbkdf2-sha256$…` deployment secret, built by ops. */
  credential?: string;
  /** Shown in `cf-connecting-ip`, which is what the rate limiter keys on. */
  ip?: string;
}

export class CloudflareRuntime {
  readonly db: SqliteD1;
  readonly env: FunctionContext['env'];
  /** Requests the page made, in order, as `METHOD /path`. */
  readonly requests: string[] = [];
  private cookie = '';
  private readonly ip: string;
  private readonly routes: Record<string, RouteModule>;

  constructor(options: CloudflareRuntimeOptions = {}) {
    this.db = options.db ?? new SqliteD1();
    this.ip = options.ip ?? '203.0.113.10';
    this.env = {
      VITA_LOG_DB: this.db as unknown as D1DatabaseLike,
      VITA_LOG_OWNER_USERNAME: options.username ?? 'owner',
      VITA_LOG_OWNER_CREDENTIAL: options.credential ?? '',
    };
    // The exact file-to-route mapping Cloudflare applies, so a route that
    // exists here but not in `functions/api/` cannot pass.
    this.routes = {
      '/api/owner-snapshot': ownerSnapshotRoute as RouteModule,
      '/api/session': sessionRoute as RouteModule,
      '/api/login': loginRoute as RouteModule,
      '/api/logout': logoutRoute as RouteModule,
      '/api/snapshot': snapshotRoute as RouteModule,
      '/api/migrate': migrateRoute as RouteModule,
      '/api/migration-preview': migrationPreviewRoute as RouteModule,
    };
  }

  /** The session cookie a browser would currently be holding, if any. */
  get sessionCookie(): string { return this.cookie; }

  /** Drop the cookie the way an expiring or cleared one would disappear. */
  clearSessionCookie(): void { this.cookie = ''; }

  /** The `fetch` the page's own code calls. */
  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(new URL(String(input), ORIGIN), init);
    const url = new URL(request.url);
    const route = this.routes[url.pathname];
    if (!route) throw new Error(`no Pages Function is deployed at ${url.pathname}`);
    this.requests.push(`${request.method} ${url.pathname}`);

    const headers = new Headers(request.headers);
    // A browser sends these on a same-origin write, and the server refuses
    // anything that lacks them. Supplying them here is modelling the browser,
    // not weakening the check.
    if (request.method !== 'GET' && request.method !== 'HEAD') headers.set('origin', url.origin);
    headers.set('host', url.host);
    headers.set('cf-connecting-ip', this.ip);
    if (this.cookie) headers.set('cookie', this.cookie);

    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();
    // Rebuilt with the browser's headers *and* the consumed body: constructing a
    // Request from another one drops the body, so routing it this way would
    // hand every write route an empty payload and make a real authorization
    // failure look like a validation failure.
    const forwarded = new Request(request.url, { method: request.method, headers, ...(body === undefined ? {} : { body }) });
    const response = await dispatch(route, request.method)({ request: forwarded, env: this.env });

    // Store the session cookie the way a browser would, so a later request is
    // authorized by the same mechanism production uses rather than by the
    // double handing out a token.
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const value = /vita-log-session=([^;]*)/.exec(setCookie)?.[1] ?? '';
      this.cookie = value ? `vita-log-session=${value}` : '';
    }
    return response;
  };

  close(): void { this.db.close(); }
}

/** Reset the isolate-global rate limiter between cases. */
export function resetRuntime(): void { clearRateLimits(); }
