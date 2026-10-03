import { describe, expect, it } from 'vitest';
import { ClientEditorAuth, type EditorAuthConfig } from '../src/auth';

class SessionMemory {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

const config: EditorAuthConfig = {
  enabled: true,
  username: 'along',
  passwordHash: '',
  salt: '',
  iterations: 1,
  sessionMinutes: 30,
  configVersion: 1,
};

describe('editor session', () => {
  it('restores a valid session and returns to read-only after expiry', () => {
    let now = 1_000;
    const session = new SessionMemory();
    session.setItem('vita-log:editor-session', JSON.stringify({ until: 2_000, version: 1 }));
    const auth = new ClientEditorAuth(config, session, null, () => now);

    expect(auth.isUnlocked()).toBe(true);
    now = 2_001;
    expect(auth.isUnlocked()).toBe(false);
  });

  it('locks an active session explicitly', () => {
    const session = new SessionMemory();
    session.setItem('vita-log:editor-session', JSON.stringify({ until: 2_000, version: 1 }));
    const auth = new ClientEditorAuth(config, session, null, () => 1_000);

    auth.lock();

    expect(auth.isUnlocked()).toBe(false);
    expect(session.getItem('vita-log:editor-session')).toBeNull();
  });
});
