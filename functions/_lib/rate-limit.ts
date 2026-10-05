/**
 * Inner-layer rate limiting for the login and write endpoints.
 *
 * The deployment runs two layers: Cloudflare Rate Limiting / WAF in front of
 * the Worker, and this counter behind it. The platform rule is the durable one
 * — it sees traffic across every isolate and every route. This one is scoped to
 * the isolate's memory on purpose: a per-account counter written to D1 would
 * add a database write to every login attempt, including the ones an attacker
 * is trying to make cheap.
 *
 * So a rotating source address cannot buy a fresh budget: the account key is
 * tracked independently of the IP key, and both must pass. That is the property
 * the outer layer alone cannot give, because a WAF rule counts addresses.
 */

/** Failed logins allowed per account and per IP inside the window. */
export const LOGIN_ATTEMPTS = 10;
/** Successful writes allowed per session inside the window. */
export const WRITE_ATTEMPTS = 120;
export const WINDOW_MS = 60_000;

export interface RateLimitVerdict {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface Window {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Window>();

/**
 * Drop the whole table.
 *
 * A Worker global outlives any single request, so without this the suite's own
 * logins would accumulate against one account and the rate-limit tests would
 * pass for the wrong reason — the budget would already be spent by an earlier
 * case rather than by the one under test.
 */
export function clearRateLimits(): void {
  buckets.clear();
}

/**
 * Count one attempt against a bucket and report whether it is still allowed.
 *
 * The counter is incremented before the verdict, so the attempt that trips the
 * limit is itself the one refused; the success path resets the bucket instead of
 * refunding it.
 */
export function consume(key: string, limit: number, now: number): RateLimitVerdict {
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  existing.count += 1;
  if (existing.count > limit) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Clear a bucket, so a correct password restores the budget it spent. */
export function reset(key: string): void {
  buckets.delete(key);
}

/** The client's address, as Cloudflare reports it. */
export function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? 'unknown';
}

export const accountKey = (username: string): string => `account:${username.trim().toLowerCase()}`;
export const addressKey = (ip: string): string => `ip:${ip}`;
export const sessionKey = (token: string): string => `session:${token}`;
