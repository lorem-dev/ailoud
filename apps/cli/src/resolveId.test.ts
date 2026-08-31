import { describe, expect, it } from 'vitest';
import { FailureError, UsageError } from '@laud/core';
import type { Recording } from '@laud/core';
import { InMemoryStore } from '@laud/core/testing';
import { resolveRecording, resolveRecordings, resolveTranscript } from './resolveId.js';

function recording(id: string, sourcePath = `/in/${id}.mp3`): Recording {
  return {
    id,
    sha256: `sha-${id}`,
    sourcePath,
    mediaPath: `xx/${id}.mp3`,
    durationMs: 1000,
    mime: 'audio/mpeg',
    title: null,
    notes: null,
    recordedAt: null,
    importedAt: '2026-01-01T00:00:00.000Z',
  };
}

async function storeWith(...ids: string[]): Promise<InMemoryStore> {
  const store = new InMemoryStore();
  for (const id of ids) await store.insertRecording(recording(id));
  return store;
}

describe('resolveRecording', () => {
  it('resolves a prefix that picks out exactly one recording', async () => {
    const store = await storeWith('01ABCDEF', '01ZZZZZZ');
    expect((await resolveRecording(store, '01A')).id).toBe('01ABCDEF');
  });

  it('accepts a full id, which is a prefix of itself', async () => {
    const store = await storeWith('01ABCDEF');
    expect((await resolveRecording(store, '01ABCDEF')).id).toBe('01ABCDEF');
  });

  it('accepts lowercase, since nobody should have to hold shift for a ULID', async () => {
    const store = await storeWith('01ABCDEF');
    expect((await resolveRecording(store, '01abc')).id).toBe('01ABCDEF');
  });

  it('ignores surrounding whitespace, which copy-paste adds', async () => {
    const store = await storeWith('01ABCDEF');
    expect((await resolveRecording(store, '  01ABC ')).id).toBe('01ABCDEF');
  });

  it('refuses a single character as too short', async () => {
    // The cost of a wrong match is asymmetric: `laud rm 0` hitting one
    // recording by luck deletes the wrong one, irreversibly.
    const store = await storeWith('01ABCDEF');
    await expect(resolveRecording(store, '0')).rejects.toThrow(UsageError);
    await expect(resolveRecording(store, '0')).rejects.toThrow(/at least 2/);
  });

  it('refuses characters that cannot appear in an id', async () => {
    // Also what keeps a LIKE wildcard out of the query.
    const store = await storeWith('01ABCDEF');
    await expect(resolveRecording(store, '01%')).rejects.toThrow(UsageError);
    await expect(resolveRecording(store, '0_1')).rejects.toThrow(UsageError);
  });

  it('says nothing matched, quoting what was asked for', async () => {
    const store = await storeWith('01ABCDEF');
    await expect(resolveRecording(store, 'ZZ')).rejects.toThrow(FailureError);
    await expect(resolveRecording(store, 'ZZ')).rejects.toThrow(/No recording matches "ZZ"/);
  });

  it('counts the matches and shows the first three when a prefix is ambiguous', async () => {
    // The common case, not the exception: a ULID starts with a timestamp, so
    // recordings imported minutes apart share long prefixes. The message has
    // to be good enough to pick a longer prefix from, without going back to
    // `laud ls`.
    const store = await storeWith('01AA', '01AB', '01AC', '01AD', '01AE');
    const error: unknown = await resolveRecording(store, '01A').catch((e: unknown) => e);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toMatch(/matches 5 recordings/);
    expect(message).toContain('01AA');
    expect(message).toContain('01AB');
    expect(message).toContain('01AC');
    // Only the first three, and the rest counted rather than listed.
    expect(message).not.toContain('01AD');
    expect(message).toMatch(/2 more/);
  });

  it('does not say "and N more" when exactly three matched', async () => {
    const store = await storeWith('01AA', '01AB', '01AC');
    const error: unknown = await resolveRecording(store, '01A').catch((e: unknown) => e);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toMatch(/matches 3 recordings/);
    // Specifically the overflow line. A bare /more/ would also catch the
    // closing "Use more characters to pick one.", which is always there.
    expect(message).not.toMatch(/and \d+ more/);
  });

  it('identifies each candidate by something a human recognises', async () => {
    const store = new InMemoryStore();
    await store.insertRecording(recording('01AA', '/in/standup.mp3'));
    await store.insertRecording(recording('01AB', '/in/interview.mp3'));
    const error: unknown = await resolveRecording(store, '01A').catch((e: unknown) => e);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain('standup.mp3');
    expect(message).toContain('interview.mp3');
  });
});

describe('resolveRecordings', () => {
  it('resolves several prefixes at once', async () => {
    const store = await storeWith('01AA', '01BB');
    const resolved = await resolveRecordings(store, ['01AA', '01B']);
    expect(resolved.map((r) => r.id)).toEqual(['01AA', '01BB']);
  });

  it('refuses the whole set when one prefix fails', async () => {
    // All-or-nothing: for `rm`, acting on the two that resolved would let a
    // typo half-delete a library with no undo.
    const store = await storeWith('01AA', '01BB');
    await expect(resolveRecordings(store, ['01AA', 'ZZ'])).rejects.toThrow(/No recording matches/);
  });

  it('refuses two prefixes that mean the same recording', async () => {
    // "rm 01A 01AA" reads as two recordings and is one; deduplicating
    // silently would report deleting one when two were asked for.
    const store = await storeWith('01AA');
    await expect(resolveRecordings(store, ['01A', '01AA'])).rejects.toThrow(UsageError);
    await expect(resolveRecordings(store, ['01A', '01AA'])).rejects.toThrow(/same recording/);
  });

  it('returns nothing for no prefixes', async () => {
    const store = await storeWith('01AA');
    expect(await resolveRecordings(store, [])).toEqual([]);
  });
});

describe('resolveTranscript', () => {
  function transcript(id: string, recordingId = 'REC1', language = 'en') {
    return {
      id,
      recordingId,
      provider: 'whisper-cpp',
      model: 'small',
      language,
      text: 'hello',
      createdAt: `2026-01-0${id.slice(-1)}T00:00:00.000Z`,
    };
  }

  async function storeWithTranscripts(...ids: string[]): Promise<InMemoryStore> {
    const store = new InMemoryStore();
    await store.insertRecording(recording('REC1'));
    for (const id of ids) await store.insertTranscript(transcript(id), []);
    return store;
  }

  it('resolves a prefix that picks out exactly one transcript', async () => {
    const store = await storeWithTranscripts('01AA1', '01BB2');
    expect((await resolveTranscript(store, '01A')).id).toBe('01AA1');
  });

  it('says nothing matched, naming transcripts rather than recordings', async () => {
    const store = await storeWithTranscripts('01AA1');
    await expect(resolveTranscript(store, 'ZZ')).rejects.toThrow(/No transcript matches "ZZ"/);
  });

  it('identifies ambiguous candidates by date and language, not by source path', async () => {
    // Two transcripts of one recording share a source path entirely, so
    // showing it would tell the user nothing about which is which.
    const store = new InMemoryStore();
    await store.insertRecording(recording('REC1'));
    await store.insertTranscript(transcript('01AA1', 'REC1', 'en'), []);
    await store.insertTranscript(transcript('01AA2', 'REC1', 'ru'), []);
    const error: unknown = await resolveTranscript(store, '01A').catch((e: unknown) => e);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toMatch(/matches 2 transcripts/);
    expect(message).toContain('en');
    expect(message).toContain('ru');
    expect(message).toContain('2026-01-0');
  });

  it('shares the prefix rules with recordings, wording them for transcripts', async () => {
    const store = await storeWithTranscripts('01AA1');
    await expect(resolveTranscript(store, 'A')).rejects.toThrow(/at least 2/);
    await expect(resolveTranscript(store, '01%')).rejects.toThrow(/not a transcript id/);
  });
});
