import { fromHex, toHex } from './hex';

/**
 * Owner password verification for the Pages Functions runtime.
 *
 * The Pages runtime has no `node:crypto`, so the self-hosted server's
 * scryptSync path cannot be shared here and is not used. This module is the
 * only place a password is turned into a digest, and it deliberately depends on
 * nothing but the platform Web Crypto that the deployment guarantees.
 *
 * A credential travels as a Cloudflare Secret, so it is encoded as one string
 * carrying every parameter the verification needs:
 *
 *   pbkdf2-sha256$100000$<saltHex>$<digestHex>
 *
 * Storing the salt, the iteration count and the digest together is what makes a
 * deployed credential self-contained — verification never reads a salt from
 * anywhere else, so a secret can be rotated by replacing the string.
 */

/**
 * The deployment cost (ADR-0002): PBKDF2-HMAC-SHA-256 at 100,000 rounds.
 *
 * 100,000 is a ceiling, not a preference. Cloudflare's *production* runtime
 * refuses PBKDF2 above that count before deriving anything:
 *
 *   NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
 *   supported (requested 210000).
 *
 * The refusal is a hard input validation, not a CPU budget, so it is identical
 * on every plan — upgrading to Workers Paid does not raise it. OWASP's current
 * floor for PBKDF2-HMAC-SHA-256 is 600,000, so this deployment knowingly runs
 * below the published recommendation; the platform offers no way to reach it and
 * the compensating control is password entropy, enforced where credentials are
 * created (see the owner CLI), not a larger iteration count here.
 *
 * Do not raise this without confirming the platform still accepts the new value
 * *in production*. Local Node and local workerd do not enforce the cap.
 */
export const PBKDF2_ITERATIONS = 100_000;

/**
 * The highest iteration count that can be verified at all.
 *
 * This is deliberately the production Cloudflare value rather than workerd's
 * own constant. workerd can be configured with a higher limit and its local
 * builds leave the check off, which is exactly why an over-limit credential
 * passes a full local test run and then fails on every real deployment. Checking
 * against the production bound here makes that failure a deterministic parse
 * rejection instead of a platform error at request time.
 *
 * Equal to PBKDF2_ITERATIONS today. The two are separate names because they mean
 * different things: raise this one first if the platform ever lifts its cap, and
 * raise the deployment cost with it. The target is OWASP's 600,000 for
 * PBKDF2-HMAC-SHA-256 — not the 210,000 this deployment originally shipped with,
 * which was the SHA-512 recommendation applied to the wrong hash.
 */
export const PLATFORM_MAX_PBKDF2_ITERATIONS = 100_000;

/**
 * This deployment cannot verify anyone.
 *
 * Covers both a credential whose cost the runtime would refuse and one that is
 * missing or malformed past use. Kept distinct from "the password was wrong"
 * because the submitted password is irrelevant: every input, including the
 * correct one, fails the same way. It means the deployment cannot verify anyone
 * until the Secret changes, so it must not be reported as a rejected credential —
 * and must not be reported as a transient outage either, because retrying never
 * fixes it.
 */
export class CredentialUnusableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CredentialUnusableError';
  }
}

/** KDF tag. Changing this invalidates every stored credential, by design. */
const KDF_TAG = 'pbkdf2-sha256';

const SALT_BYTES = 16;
const DIGEST_BYTES = 32;

export interface PasswordCredential {
  iterations: number;
  salt: Uint8Array;
  digest: Uint8Array;
}

/** The slice of the platform crypto this module uses; injectable for tests. */
export interface RandomSource {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

const platformRandom: RandomSource = globalThis.crypto;

/** A fresh 128-bit salt. Every credential gets its own; nothing is shared. */
export function generateSalt(random: RandomSource = platformRandom): Uint8Array {
  return random.getRandomValues(new Uint8Array(SALT_BYTES));
}

/**
 * Run PBKDF2-HMAC-SHA-256 over one password. The cost is paid on every verify.
 *
 * Two ways an unusable cost is turned into `CredentialUnusableError` rather than
 * surfacing as a generic `Error`: an out-of-range count is refused here, and the
 * known iteration-limit refusal from the runtime is converted. Left as a generic
 * `Error`, the login route's catch-all reported it as "健康数据服务暂时不可用，请稍后重试" — which
 * sends the owner to investigate D1, WAF and Access while the real defect is the
 * credential Secret, and tells them to retry something that cannot start working.
 */
export async function derivePassword(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  // Refused on this side rather than left to the platform to reject. Cloudflare
  // would answer with a NotSupportedError that only ever appears in production,
  // which is how the original defect passed a full local suite; failing here
  // makes the same mistake observable locally, and gives it the error type the
  // login route needs in order to report it honestly.
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > PLATFORM_MAX_PBKDF2_ITERATIONS) {
    throw new CredentialUnusableError(
      `迭代数 ${iterations} 不在 1–${PLATFORM_MAX_PBKDF2_ITERATIONS} 的可校验范围内`,
    );
  }
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: salt as unknown as BufferSource, iterations },
      key,
      DIGEST_BYTES * 8,
    );
    return new Uint8Array(bits);
  } catch (error) {
    // Only the platform's known iteration-cap refusal means that the Secret is
    // unusable. Other Web Crypto failures are runtime/service failures and must
    // retain their generic classification so they do not send an operator to
    // rotate a healthy Secret.
    if (!isPbkdf2IterationLimitError(error)) throw error;
    throw new CredentialUnusableError(
      `当前运行环境无法执行 ${iterations} 次 PBKDF2（上限 ${PLATFORM_MAX_PBKDF2_ITERATIONS}），请更换迭代数不超过上限的凭据`,
      { cause: error },
    );
  }
}

function isPbkdf2IterationLimitError(error: unknown): boolean {
  const text = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
  return /NotSupportedError/i.test(text)
    && /Pbkdf2 failed: iteration counts above \d+ are not supported/i.test(text);
}

/** Build an encodable credential for a password, with a fresh independent salt. */
export async function createCredential(password: string, random: RandomSource = platformRandom): Promise<string> {
  const salt = generateSalt(random);
  const digest = await derivePassword(password, salt, PBKDF2_ITERATIONS);
  return `${KDF_TAG}$${PBKDF2_ITERATIONS}$${toHex(salt)}$${toHex(digest)}`;
}

/**
 * Parse an encoded credential, or return null.
 *
 * Null means "this secret is unusable", and every caller must treat that as
 * closed. The format is checked strictly — exact field count, exact KDF tag,
 * exact salt and digest widths, lowercase hex, and a cost inside the published
 * bounds — because a lenient parse would let a malformed or downgraded secret
 * authenticate by accident instead of refusing to.
 *
 * The cost bounds are both load-bearing. Below `PBKDF2_ITERATIONS` is a secret
 * that turns the KDF down; above `PLATFORM_MAX_PBKDF2_ITERATIONS` is a secret
 * the runtime will refuse to use at all. The second bound is what stops the very
 * first deployment of this app from shipping a credential that passes every
 * local test and fails on every request.
 *
 * Because the two bounds are equal today, exactly one iteration count passes:
 * the deployment cost. The `<iterations>` field in the encoded form is not a
 * dial — it exists so a future rotation to a different cost can travel inside
 * the string without changing the format, not so a deployment can pick one.
 * Widening the accepted range is a decision about which costs this deployment is
 * willing to verify, and it has to be made here, together with the deployment
 * cost, never by editing a Secret alone.
 */
export function parseCredential(raw: unknown): PasswordCredential | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return null;

  const parts = raw.split('$');
  if (parts.length !== 4 || parts[0] !== KDF_TAG) return null;

  const iterations = Number(parts[1]);
  if (!/^\d{1,7}$/.test(parts[1])) return null;
  if (!Number.isSafeInteger(iterations) || iterations < PBKDF2_ITERATIONS || iterations > PLATFORM_MAX_PBKDF2_ITERATIONS) return null;

  const salt = fromHex(parts[2]);
  const digest = fromHex(parts[3]);
  if (!salt || salt.length !== SALT_BYTES) return null;
  if (!digest || digest.length !== DIGEST_BYTES) return null;

  return { iterations, salt, digest };
}

/**
 * Check a password against a stored credential.
 *
 * Any unusable input is a rejection, never a fallback: an unparseable secret,
 * a missing secret and a wrong password all come back false, so a deployment
 * with a broken secret is closed rather than open.
 */
export async function verifyPassword(password: string, credential: string | PasswordCredential | null | undefined): Promise<boolean> {
  const parsed = typeof credential === 'string' ? parseCredential(credential) : credential ?? null;
  if (!parsed) return false;
  const candidate = await derivePassword(password, parsed.salt, parsed.iterations);
  return constantTimeEqual(candidate, parsed.digest);
}

/**
 * Compare two digests without an early exit.
 *
 * The Workers runtime has no `timingSafeEqual`, so the XOR accumulator is done
 * by hand. Length is compared first, which leaks nothing here: the digest width
 * is fixed by the KDF, so a length difference means a malformed record rather
 * than a guessable prefix.
 */
function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

/**
 * Explain why a credential cannot be verified, or return null if it can.
 *
 * The deploy-time half of the check `parseCredential` makes at request time, and
 * it exists because request time is the worst place to discover this: the owner
 * finds out only after deploying, putting data behind it and trying to log in,
 * and the failure surfaces as an unrelated-looking error. Running this where the
 * Secret is produced turns it into a refusal before anything ships.
 */
export function describeCredentialProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return '凭据缺失';
  if (parseCredential(raw)) return null;
  // The two bounds are equal today, so naming them as a range would read as a
  // typo in the one message an operator is meant to act on.
  const cost = PBKDF2_ITERATIONS === PLATFORM_MAX_PBKDF2_ITERATIONS
    ? `迭代数须为 ${PBKDF2_ITERATIONS}`
    : `迭代数在 ${PBKDF2_ITERATIONS}–${PLATFORM_MAX_PBKDF2_ITERATIONS} 之间`;
  return `凭据无法校验：需要 ${KDF_TAG}$<迭代数>$<盐>$<摘要>，${cost}，盐 16 字节、摘要 32 字节的十六进制`;
}

