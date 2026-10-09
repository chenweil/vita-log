/**
 * The password floor for owner credentials this project creates.
 *
 * It lives apart from the CLI so that the deployment wizard, which generates the
 * Secret from the same password, applies the identical rule instead of keeping
 * its own copy. A second copy is how the two drift, and the drift would be
 * silent: the wizard would generate a credential for a password the CLI had
 * already refused.
 *
 * This policy is load-bearing rather than decorative. The platform caps PBKDF2
 * at 100,000 iterations, well under OWASP's 600,000 for PBKDF2-HMAC-SHA-256, so
 * the cost of one offline guess is fixed below the recommendation and no plan
 * raises it — see the constant block in `functions/_lib/password.ts`. Entropy is
 * the remaining lever that moves an offline attack by orders of magnitude rather
 * than by a factor of two, which is why the floor is a passphrase-sized 20.
 *
 * Deliberately NOT applied at login. A credential created before this rule must
 * still be able to sign in; raising a floor at the door locks the owner out
 * instead of protecting anything.
 */

/** Passphrase-sized: four random words clear it, a single word does not. */
export const MIN_PASSWORD_LENGTH = 20;

/**
 * A 20-character password drawn from fewer than this many distinct characters is
 * long without being unpredictable — `abcabcabcabcabcabcab` is 20 characters
 * carrying almost no entropy.
 */
const MIN_DISTINCT_CHARACTERS = 10;

/** Deliberately tiny: a floor that stops the obvious, not a strength meter. */
const COMMON_SUBSTRINGS = ['password', 'passphrase', 'qwerty', 'letmein', 'iloveyou', '123456', '111111', 'admin'];

const MAX_PASSWORD_LENGTH = 1024;

/** Why this password is unacceptable, or null if it clears the floor. */
export function describePasswordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符。迭代数受平台上限约束，离线爆破的抵抗主要来自长度与随机性，建议用 4 个以上随机词组成的短语。`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) return '密码过长';

  // Length alone is not entropy: a long password can still be a short pattern
  // repeated, which is the first thing an offline attack tries.
  const distinct = new Set(password).size;
  if (distinct < MIN_DISTINCT_CHARACTERS) {
    return `密码只用到 ${distinct} 种不同字符，至少需要 ${MIN_DISTINCT_CHARACTERS} 种。`;
  }
  if (/(.{1,4})\1{3,}/.test(password)) return '密码包含连续重复的片段，例如 abcabcabcabc。';

  const lowered = password.toLowerCase();
  const common = COMMON_SUBSTRINGS.find((word) => lowered.includes(word));
  if (common) return `密码包含常见弱口令片段「${common}」。`;

  return null;
}
