import { describe, expect, it } from 'vitest';
import { describePasswordProblem, MIN_PASSWORD_LENGTH } from '../server/credential-policy';

describe('本人凭据的密码门槛', () => {
  it('接受 4 个词左右的随机短语', () => {
    // The shape this policy aims at. If a real passphrase were rejected, the floor
    // would push the owner toward something shorter and worse, which is the
    // opposite of what it is for.
    expect(describePasswordProblem('correct horse battery staple')).toBeNull();
    expect(describePasswordProblem('Tr0ub4dor&3-Correct-Battery')).toBeNull();
  });

  it('门槛是 20 个字符', () => {
    // 12 was the old floor. It is raised because the platform caps PBKDF2 below
    // OWASP's recommendation, leaving entropy as the lever that still moves an
    // offline attack by orders of magnitude.
    expect(MIN_PASSWORD_LENGTH).toBe(20);
    expect(describePasswordProblem('a'.repeat(MIN_PASSWORD_LENGTH - 1))).toContain('至少需要 20 个字符');
    expect(describePasswordProblem('a'.repeat(MIN_PASSWORD_LENGTH))).toContain('不同字符');
  });

  it('长但低熵的密码被拒绝：长度不等于熵', () => {
    // 20 characters carrying almost no entropy, which is the first thing an
    // offline attack tries and the reason a length-only floor is not enough.
    expect(describePasswordProblem('abcabcabcabcabcabcab')).toContain('不同字符');
    expect(describePasswordProblem('a'.repeat(32))).toContain('不同字符');
    // Enough distinct characters to clear that rule, but still a pattern repeated
    // until it reached the length floor.
    expect(describePasswordProblem('abcdefghijzzzzzzzzzz')).toContain('重复');
  });

  it('常见弱口令片段被拒绝，按子串而不是全等', () => {
    // A long password built around a common word is the realistic failure, and it
    // is exactly what a dictionary attack tries first.
    expect(describePasswordProblem('thisisapasswordthatislong')).toContain('常见弱口令');
    expect(describePasswordProblem('Qwerty-with-extra-bits')).toContain('常见弱口令');
  });

  it('超长输入被拒绝，不让 KDF 承担无界输入', () => {
    expect(describePasswordProblem('x'.repeat(1025))).toBe('密码过长');
  });

  it('空密码得到长度理由，而不是被判为可用', () => {
    // The login route's own floor is only there to keep implausible input out of
    // the KDF; this one is the policy, and it must never wave an empty password
    // through to a credential that cannot be protected by anything.
    expect(describePasswordProblem('')).toContain('至少需要 20 个字符');
  });
});
