import { createCredential, verifyPassword } from './password';

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
  /** Encoded `pbkdf2-sha256$<iterations>$<salt>$<digest>`; see password.ts. */
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
 * Every failure — wrong username, wrong password, missing secret, corrupt
 * secret — is the same false. Collapsing them keeps a probe from learning
 * whether the deployment is configured at all, which is internal state the
 * public read path already refuses to expose.
 */
export async function verifyOwnerCredentials(env: OwnerEnv, username: unknown, password: unknown): Promise<boolean> {
  if (typeof username !== 'string' || typeof password !== 'string') return false;
  const expectedUser = env.VITA_LOG_OWNER_USERNAME;
  const credential = env.VITA_LOG_OWNER_CREDENTIAL;
  if (!expectedUser || !credential) return false;
  if (username.trim() !== expectedUser.trim()) {
    // Still spend the KDF so a wrong username is not distinguishable by timing.
    await verifyPassword(password, credential);
    return false;
  }
  return verifyPassword(password, credential);
}
