/**
 * Credential-material scanner.
 *
 * The bundle is public and so is the repository. A password hash, a salt or a
 * retired credential that reaches either is handed to every visitor, and both
 * are exactly the kind of constant that survives unnoticed: a leftover config
 * object reads as ordinary code.
 *
 * Patterns deliberately require a *non-empty, correctly shaped* value, and they
 * exempt redaction placeholders. A placeholder carries no secret — it is what
 * the retired credential was replaced with — and a scanner that flags one would
 * point at files that are already safe, and then get disabled rather than fixed.
 * A shape like `/salt/` alone would fire on prose and on a type declaration for
 * the same reason: a check that is always right is a check that gets switched
 * off.
 *
 * An empty value is excluded by requiring characters rather than by a
 * lookahead, so `passwordHash: ''` — the field the retired credential was
 * emptied into — stays silent without a special case for it.
 */
const PLACEHOLDERS = '(?!REDACTED|redacted|xxxx)';
const OBVIOUS_PLACEHOLDERS = '(?!REDACTED|redacted|owner|change-?me|example\\.com)';

export const CREDENTIAL_SHAPES = [
  {
    label: 'passwordHash 字面量',
    pattern: new RegExp(`passwordHash\\s*[:=]\\s*['"]${PLACEHOLDERS}[^'"]{2,}['"]`),
  },
  { label: 'salt 字面量', pattern: /\bsalt\s*[:=]\s*['"][0-9a-f]{16,}['"]/ },
  { label: '预置的 PBKDF2 凭据', pattern: /pbkdf2-sha256\$\d+\$[0-9a-f]{32}\$[0-9a-f]{64}/ },
  { label: '预置的 scrypt 凭据', pattern: /scrypt\$[0-9a-f]{16,}/ },
  {
    label: '真实账号或口令字面量',
    pattern: new RegExp(`\\b(username|password)\\s*[:=]\\s*['"]${OBVIOUS_PLACEHOLDERS}[^'"]{6,}['"]`, 'i'),
  },
];

/**
 * Shapes that survive minification, for scanning a built bundle.
 *
 * The patterns above are keyed on identifiers like `passwordHash`, and the
 * bundler renames locals — a credential constant reaches `dist/` as
 * `const e="9f86…"` and a name-keyed check sails straight past it. These match
 * on the *value*, which is what actually has to not ship. A 32+ character bare
 * hex literal is a 16-byte salt or a 32-byte digest; the app has no legitimate
 * one, so this stays quiet in practice and is verified as such by a test.
 */
export const MINIFIED_CREDENTIAL_SHAPES = [
  { label: '疑似盐或摘要的长十六进制字面量', pattern: /['"][0-9a-f]{32,}['"]/ },
  { label: '预置的 PBKDF2 凭据', pattern: /pbkdf2-sha256\$\d+\$[0-9a-f]{32}\$[0-9a-f]{64}/ },
  { label: '预置的 scrypt 凭据', pattern: /scrypt\$[0-9a-f]{16,}/ },
];

/**
 * The first credential-shaped value in `text`, or null.
 *
 * Returns the label rather than a boolean so a failure can say what was found —
 * a check that only reports "no" leaves the next person guessing what to hunt
 * for. `minified` selects the value-shaped set, which is the only one that can
 * see into a built bundle.
 */
export function findCredentialMaterial(text, { minified = false } = {}) {
  for (const { label, pattern } of minified ? MINIFIED_CREDENTIAL_SHAPES : CREDENTIAL_SHAPES) {
    if (pattern.test(text)) return label;
  }
  return null;
}