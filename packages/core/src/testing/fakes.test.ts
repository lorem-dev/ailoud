import { describe, expect, it } from 'vitest';
import { InMemoryStore } from './fakes.js';
import type { Recording, Transcript } from '../domain/model.js';

const recording = (overrides: Partial<Recording> = {}): Recording => ({
  id: 'ID001',
  sha256: 'sha-AUDIO',
  sourcePath: '/in/talk.mp3',
  mediaPath: 'sh/sha-AUDIO.mp3',
  durationMs: 1000,
  mime: 'audio/mpeg',
  title: null,
  notes: null,
  importedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const transcript = (overrides: Partial<Transcript> = {}): Transcript => ({
  id: 'T001',
  recordingId: 'ID001',
  provider: 'fake',
  model: 'fake-model',
  language: 'en',
  text: 'hello',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('InMemoryStore.listRecordings', () => {
  it('breaks a tie on importedAt by ascending id, matching SqliteStore', async () => {
    const store = new InMemoryStore();
    await store.insertRecording(recording({ id: 'ID002' }));
    await store.insertRecording(recording({ id: 'ID001' }));
    const result = await store.listRecordings({});
    expect(result.map((r) => r.id)).toEqual(['ID001', 'ID002']);
  });

  it('treats an empty ids filter as no filter, matching SqliteStore', async () => {
    const store = new InMemoryStore();
    await store.insertRecording(recording({ id: 'ID001' }));
    await store.insertRecording(recording({ id: 'ID002' }));
    const result = await store.listRecordings({ ids: [] });
    expect(result.map((r) => r.id).sort()).toEqual(['ID001', 'ID002']);
  });
});

describe('InMemoryStore.latestTranscript', () => {
  it('breaks a tie on createdAt by descending id, matching SqliteStore', async () => {
    const store = new InMemoryStore();
    await store.insertTranscript(transcript({ id: 'T001' }), []);
    await store.insertTranscript(transcript({ id: 'T002' }), []);
    const result = await store.latestTranscript('ID001');
    expect(result?.id).toBe('T002');
  });
});

describe('InMemoryStore.getTranscript', () => {
  it('fetches a transcript by its own id, matching SqliteStore', async () => {
    const store = new InMemoryStore();
    await store.insertTranscript(transcript({ id: 'T001' }), []);
    expect(await store.getTranscript('T001')).toEqual(transcript({ id: 'T001' }));
  });

  it('returns null for an unknown transcript id, matching SqliteStore', async () => {
    const store = new InMemoryStore();
    expect(await store.getTranscript('nope')).toBeNull();
  });
});
