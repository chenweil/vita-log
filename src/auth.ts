export interface EditorAuth {
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
  isUnlocked(): boolean { return false; }
  async unlock(_username: string, _password: string): Promise<boolean> { return false; }
  async lock(): Promise<void> {}
}
