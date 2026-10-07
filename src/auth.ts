/**
 * What a login attempt turned out to be.
 *
 * There is deliberately no `failed`. A refused credential, a rate limit and an
 * unreachable service all used to arrive as the same `false`, and the page —
 * having nothing else to work with — reported every one of them as "账号或密码
 * 错误". Two of those three call for opposite actions: check your password, or
 * come back later. The third is not even information the owner has.
 */
export type UnlockResult =
  /** The server opened an owner session. There is nothing to report. */
  { outcome: 'unlocked' }
  /** Wrong password, unknown account, or input the server will not accept. */
  | { outcome: 'rejected'; message: string }
  /** Too many attempts: the same repair as before will keep being refused. */
  | { outcome: 'limited'; message: string }
  /** The service could not be reached, or did not answer in a way we understand. */
  | { outcome: 'unavailable'; message: string };

export interface EditorAuth {
  /**
   * Whether this deployment can ever open an editor, as opposed to being
   * read-only right now.
   *
   * This is deliberately not `isUnlocked()`. The page needs to tell "log in to
   * edit" apart from "this build has no way to edit at all", and those are
   * different statements: the pure static build shows a dashboard with no
   * editor, and promising a verification route there would be a promise the
   * deployment cannot keep. `isUnlocked()` cannot answer it, because a
   * read-only deployment is permanently false while a locked owner session is
   * false for the next half hour.
   */
  canUnlock(): boolean;
  isUnlocked(): boolean;
  unlock(username: string, password: string): Promise<UnlockResult>;
  lock(): Promise<void>;
}

/**
 * The only client-side editor boundary. It never unlocks, so it is correct
 * for any mode without a server to authorize writes: a published reader
 * snapshot, and the purely static localStorage build.
 *
 * There is deliberately no client-side password check here. Verifying a
 * password in the browser would only hide controls, while the hash ships in
 * the bundle, so it would be a false boundary. Write authorization belongs
 * to the server, which ServerEditorAuth drives.
 */
export class ReadOnlyEditorAuth implements EditorAuth {
  canUnlock(): boolean { return false; }
  isUnlocked(): boolean { return false; }
  async unlock(_username: string, _password: string): Promise<UnlockResult> {
    // `unavailable` rather than `rejected`: nothing evaluated these credentials,
    // so there is no verdict on them to report — there is simply no login
    // service here to evaluate them against. The page never asks (it renders no
    // unlock control while `canUnlock()` is false), so this is the answer to a
    // question nobody poses; it is pinned only so it cannot quietly grow into a
    // claim about the password.
    return { outcome: 'unavailable', message: '当前为纯静态只读页面，没有编辑入口。' };
  }
  async lock(): Promise<void> {}
}
