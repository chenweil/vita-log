export interface EditorAuth {
  isUnlocked(): boolean;
  unlock(username: string, password: string): Promise<boolean>;
  lock(): void;
}

/** Authentication boundary used by a published reader page. */
export class ReadOnlyEditorAuth implements EditorAuth {
  isUnlocked(): boolean { return false; }
  async unlock(_username: string, _password: string): Promise<boolean> { return false; }
  lock(): void {}
}

interface SessionLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface CryptoLike {
  subtle: SubtleCrypto;
}

interface AuthSession {
  until: number;
  version: number;
}

export interface EditorAuthConfig {
  enabled: boolean;
  username: string;
  passwordHash: string;
  salt: string;
  iterations: number;
  sessionMinutes: number;
  configVersion: number;
}

const SESSION_KEY = 'vita-log:editor-session';

export class ClientEditorAuth implements EditorAuth {
  private unlockedUntil = 0;

  constructor(
    private readonly config: EditorAuthConfig,
    private readonly session: SessionLike | null = typeof window === 'undefined' ? null : window.sessionStorage,
    private readonly cryptoProvider: CryptoLike | null = typeof window === 'undefined' ? null : window.crypto,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.restoreSession();
  }

  isUnlocked(): boolean {
    if (!this.config.enabled) return true;
    if (this.unlockedUntil > this.now()) return true;
    this.unlockedUntil = 0;
    this.session?.removeItem(SESSION_KEY);
    return false;
  }

  async unlock(username: string, password: string): Promise<boolean> {
    if (!this.config.enabled) return true;
    if (username !== this.config.username || !this.cryptoProvider?.subtle) return false;
    try {
      const passphrase = new TextEncoder().encode(password);
      const key = await this.cryptoProvider.subtle.importKey('raw', passphrase, 'PBKDF2', false, ['deriveBits']);
      const bits = await this.cryptoProvider.subtle.deriveBits(
        { name: 'PBKDF2', salt: decodeBase64(this.config.salt), iterations: this.config.iterations, hash: 'SHA-256' },
        key,
        256,
      );
      if (!sameBytes(new Uint8Array(bits), new Uint8Array(decodeBase64(this.config.passwordHash)))) return false;
      this.unlockedUntil = this.now() + this.config.sessionMinutes * 60_000;
      this.session?.setItem(SESSION_KEY, JSON.stringify({ until: this.unlockedUntil, version: this.config.configVersion } satisfies AuthSession));
      return true;
    } catch {
      return false;
    }
  }

  lock(): void {
    this.unlockedUntil = 0;
    this.session?.removeItem(SESSION_KEY);
  }

  private restoreSession(): void {
    if (!this.session) return;
    try {
      const raw = this.session.getItem(SESSION_KEY);
      if (!raw) return;
      const value = JSON.parse(raw) as Partial<AuthSession>;
      if (value.version === this.config.configVersion && typeof value.until === 'number' && value.until > this.now()) {
        this.unlockedUntil = value.until;
      }
    } catch {
      this.session.removeItem(SESSION_KEY);
    }
  }
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return bytes.buffer.slice(0) as ArrayBuffer;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}
