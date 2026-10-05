import { describe, expect, it } from 'vitest';
import { ReadOnlyEditorAuth } from '../src/auth';

describe('read-only editor auth', () => {
  it('never unlocks, whatever credentials are offered', async () => {
    const auth = new ReadOnlyEditorAuth();

    expect(await auth.unlock('owner', 'long-password')).toBe(false);
    expect(auth.isUnlocked()).toBe(false);
  });

  it('stays read-only after lock, so a session cannot be revived client-side', () => {
    const auth = new ReadOnlyEditorAuth();

    auth.lock();

    expect(auth.isUnlocked()).toBe(false);
  });
});
