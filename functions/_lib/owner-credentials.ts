import { createCredential, CredentialUnusableError, describeCredentialProblem, verifyPassword } from './password';

/**
 * The owner credential comes from the deployment, never from a request.
 *
 * There is deliberately no public setup, registration or password-reset route
 * anywhere in this file or in the routes that use it: a visitor must not be
 * able to become the first administrator, and a forgotten password is recovered
 * offline (06.1-02b). The credential is provisioned as a Cloudflare Secret by
 * a one-off ops command, and the environment is the only thing that can produce
 * one.
 */
export interface OwnerEnv {
  VITA_LOG_OWNER_USERNAME?: string;
  /**
   * Encoded `pbkdf2-sha256$<iterations>$<salt>$<digest>`; see password.ts.
   * The iteration field is not a dial: exactly one value passes the parse today,
   * so this Secret cannot be used to tune the cost. See parseCredential.
   */
  VITA_LOG_OWNER_CREDENTIAL?: string;
}

/**
 * Build the value to paste into the VITA_LOG_OWNER_CREDENTIAL secret.
 *
 * This is an ops-time helper, not a request path: it is the offline step that
 * turns a chosen password into a salted digest. Keeping it here means the ops
 * command and the runtime agree on the encoding by construction, and the
 * plaintext password never has to be written anywhere but the terminal.
 */
export async function createOwnerCredential(password: string): Promise<string> {
  return createCredential(password);
}

/**
 * Check submitted credentials against the deployment secret.
 *
 * Every outcome of a *submission* is one boolean: there is deliberately no
 * "no such user" result, so a probe cannot enumerate usernames, and a wrong
 * password is indistinguishable from a wrong username. That still holds.
 *
 * What is no longer collapsed is a deployment that cannot verify anything at all.
 * A missing Secret, or a credential whose format or cost the runtime refuses,
 * fails identically for every input including the correct one. Reporting that as
 * "账号或密码错误" sends the owner to change a password that was never the
 * problem, and invites retries that cannot succeed — so it is raised instead and
 * the login route says what is actually wrong.
 *
 * The cost of that choice is one bit of deployment state visible to an
 * unauthenticated caller: that this deployment's credential is unusable. It is
 * worth paying. Nothing is reachable either way — no session is issued, and the
 * public read path is public regardless — while without it the owner of a
 * misconfigured deployment has no signal at all, because every self-service
 * remedy they can think of (another password, another session, a restart) is
 * aimed at the wrong thing.
 */
export async function verifyOwnerCredentials(env: OwnerEnv, username: unknown, password: unknown): Promise<boolean> {
  if (typeof username !== 'string' || typeof password !== 'string') return false;

  const expectedUser = env.VITA_LOG_OWNER_USERNAME;
  const credential = env.VITA_LOG_OWNER_CREDENTIAL;
  if (!expectedUser) throw new CredentialUnusableError('部署缺少 VITA_LOG_OWNER_USERNAME');
  const problem = describeCredentialProblem(credential);
  if (problem) throw new CredentialUnusableError(problem);

  if (username.trim() !== expectedUser.trim()) {
    // Still spend the KDF so a wrong username is not distinguishable by timing.
    await verifyPassword(password, credential);
    return false;
  }
  return verifyPassword(password, credential);
}
