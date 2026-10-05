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
 *   pbkdf2-sha256$210000$<saltHex>$<digestHex>
 *
 * Storing the salt, the iteration count and the digest together is what makes a
 * deployed credential self-contained — verification never reads a salt from
 * anywhere else, so a secret can be rotated by replacing the string.
 */

/** The deployment decision (ADR-0002): PBKDF2-HMAC-SHA-256 at 210,000 rounds. */
export const PBKDF2_ITERATIONS = 210_000;

/** KDF tag. Changing this invalidates every stored credential, by design. */
const KDF_TAG = 'pbkdf2-sha256';

const SALT_BYTES = 16;
const DIGEST_BYTES = 32;

/**
 * Upper bound accepted from a stored credential.
 *
 * The iteration count is attacker-uncontrollable (it comes from a secret), but
 * a mistyped value like 99999999999 would turn one login into an unbounded
 * amount of CPU inside a Worker. Anything under the published floor is
 * rejected outright rather than silently accepted, because a credential that
 * turns the KDF down is exactly the regression 210,000 exists to prevent.
 */
const MAX_PBKDF2_ITERATIONS = 1_000_000;

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

/** Run PBKDF2-HMAC-SHA-256 over one password. The cost is paid on every verify. */
export async function derivePassword(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as unknown as BufferSource, iterations },
    key,
    DIGEST_BYTES * 8,
  );
  return new Uint8Array(bits);
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
 */
export function parseCredential(raw: unknown): PasswordCredential | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return null;

  const parts = raw.split('$');
  if (parts.length !== 4 || parts[0] !== KDF_TAG) return null;

  const iterations = Number(parts[1]);
  if (!/^\d{1,7}$/.test(parts[1])) return null;
  if (!Number.isSafeInteger(iterations) || iterations < PBKDF2_ITERATIONS || iterations > MAX_PBKDF2_ITERATIONS) return null;

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

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(value: string): Uint8Array | null {
  if (!/^[0-9a-f]*$/.test(value) || value.length % 2 !== 0) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}
