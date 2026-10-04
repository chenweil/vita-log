import { describe, expect, it } from 'vitest';
import { createEmptySnapshot } from '../src/domain';
import {
  createPublication,
  parsePublication,
  PublishedHealthRepository,
  PUBLICATION_SCHEMA_VERSION,
  serializePublication,
} from '../src/publication';

describe('read-only publication', () => {
  it('publishes a versioned projection with timestamp and no extra internal fields', () => {
    const snapshot = createEmptySnapshot('2026-10-05T00:00:00.000Z');
    snapshot.settings.name = 'Along';
    const withInternalFields = { ...snapshot, editorPassword: 'secret', recovery: { anything: true }, pendingOperations: ['write'] } as typeof snapshot & Record<string, unknown>;

    const publication = createPublication(withInternalFields, '2026-10-05T01:02:03.000Z');
    const raw = serializePublication(publication);
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    expect(publication.publicationSchemaVersion).toBe(PUBLICATION_SCHEMA_VERSION);
    expect(publication.publishedAt).toBe('2026-10-05T01:02:03.000Z');
    expect(parsed).not.toHaveProperty('editorPassword');
    expect(parsed).not.toHaveProperty('recovery');
    expect(parsed).not.toHaveProperty('pendingOperations');
    expect((parsed.snapshot as { settings: { name: string } }).settings.name).toBe('Along');
  });

  it('rejects malformed or unsupported publication files', () => {
    expect(() => parsePublication('{bad json')).toThrow('不是有效的 JSON');
    expect(() => parsePublication(JSON.stringify({ app: 'vita-log-publication', publicationSchemaVersion: 2 }))).toThrow('不支持');
  });

  it('serves data while rejecting every write through the repository contract', async () => {
    const snapshot = createEmptySnapshot('2026-10-05T00:00:00.000Z');
    const repository = new PublishedHealthRepository(createPublication(snapshot, '2026-10-05T01:02:03.000Z'));

    expect((await repository.load()).status).toBe('loaded');
    await expect(repository.commit(snapshot)).rejects.toMatchObject({ code: 'write-failed' });
    await expect(repository.loadRecovery()).rejects.toMatchObject({ code: 'recovery-unavailable' });
  });
});
