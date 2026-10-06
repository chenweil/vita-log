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
  unlock(username: string, password: string): Promise<boolean>;
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
  async unlock(_username: string, _password: string): Promise<boolean> { return false; }
  async lock(): Promise<void> {}
}
