import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Recording, Segment, Transcript } from '@laud/core';
import { MIGRATIONS, SCHEMA_VERSION } from '@laud/core';
import { openStore } from './sqliteStore.js';

const recording: Recording = {
  id: 'R1',
  sha256: 'abc',
  sourcePath: '/in/a.mp3',
  mediaPath: 'ab/abc.mp3',
  durationMs: 1000,
  mime: 'audio/mpeg',
  title: null,
  notes: null,
  recordedAt: null,
  importedAt: '2026-01-01T00:00:00.000Z',
};

const transcript: Transcript = {
  id: 'T1',
  recordingId: 'R1',
  provider: 'whisper-cpp',
  model: 'base',
  language: 'en',
  text: 'hello world',
  createdAt: '2026-01-01T00:01:00.000Z',
};

const segments: Segment[] = [
  {
    id: 'S1',
    transcriptId: 'T1',
    idx: 0,
    startMs: 0,
    endMs: 500,
    text: 'hello',
    speaker: null,
    language: null,
  },
  {
    id: 'S2',
    transcriptId: 'T1',
    idx: 1,
    startMs: 500,
    endMs: 1000,
    text: 'world',
    speaker: null,
    language: null,
  },
];

/** A segment with only the fields these language tests care about. */
function seg(partial: Partial<Segment> & { id: string; idx: number }): Segment {
  return {
    transcriptId: 'T1',
    startMs: 0,
    endMs: 1000,
    text: 'x',
    speaker: null,
    language: null,
    ...partial,
  };
}

describe('SqliteStore.languagesByTranscript', () => {
  it('returns nothing, and runs no query, for an empty id list', async () => {
    const store = openStore(':memory:');
    // `IN ()` is a SQL syntax error, so the empty case must short-circuit.
    expect(await store.languagesByTranscript([])).toEqual(new Map());
    store.close();
  });

  it('lists every language of a code-switched transcript, most-spoken first', async () => {
    const store = openStore(':memory:');
    await store.insertRecording(recording);
    await store.insertTranscript(transcript, [
      seg({ id: 'S1', idx: 0, startMs: 0, endMs: 500, language: 'en' }),
      seg({ id: 'S2', idx: 1, startMs: 500, endMs: 4000, language: 'ru' }),
    ]);
    expect(await store.languagesByTranscript(['T1'])).toEqual(new Map([['T1', ['ru', 'en']]]));
    store.close();
  });

  it('sums a language spread across separated runs', async () => {
    const store = openStore(':memory:');
    await store.insertRecording(recording);
    await store.insertTranscript(transcript, [
      seg({ id: 'S1', idx: 0, startMs: 0, endMs: 1000, language: 'en' }),
      seg({ id: 'S2', idx: 1, startMs: 1000, endMs: 2500, language: 'ru' }),
      seg({ id: 'S3', idx: 2, startMs: 2500, endMs: 3600, language: 'en' }),
    ]);
    // en totals 2100 ms across two runs, ru 1500 ms in one.
    expect(await store.languagesByTranscript(['T1'])).toEqual(new Map([['T1', ['en', 'ru']]]));
    store.close();
  });

  it('breaks a duration tie by first appearance, matching summarizeLanguages', async () => {
    const store = openStore(':memory:');
    await store.insertRecording(recording);
    await store.insertTranscript(transcript, [
      seg({ id: 'S1', idx: 0, startMs: 0, endMs: 1000, language: 'ru' }),
      seg({ id: 'S2', idx: 1, startMs: 1000, endMs: 2000, language: 'en' }),
    ]);
    expect(await store.languagesByTranscript(['T1'])).toEqual(new Map([['T1', ['ru', 'en']]]));
    store.close();
  });

  it('clamps a negative span so it cannot reorder the result', async () => {
    const store = openStore(':memory:');
    await store.insertRecording(recording);
    await store.insertTranscript(transcript, [
      seg({ id: 'S1', idx: 0, startMs: 0, endMs: 3000, language: 'en' }),
      seg({ id: 'S2', idx: 1, startMs: 3000, endMs: 1000, language: 'en' }),
      seg({ id: 'S3', idx: 2, startMs: 3000, endMs: 4000, language: 'ru' }),
    ]);
    // Without the max(x, 0) clamp the bad span would subtract 2000 ms from en
    // and drop it below ru.
    expect(await store.languagesByTranscript(['T1'])).toEqual(new Map([['T1', ['en', 'ru']]]));
    store.close();
  });

  it('omits a transcript whose segments record no language', async () => {
    const store = openStore(':memory:');
    await store.insertRecording(recording);
    await store.insertTranscript(transcript, segments); // both segments have language null
    expect(await store.languagesByTranscript(['T1'])).toEqual(new Map());
    store.close();
  });

  it('answers for several transcripts in one call, keeping them apart', async () => {
    const store = openStore(':memory:');
    await store.insertRecording(recording);
    await store.insertRecording({ ...recording, id: 'R2', sha256: 'def', mediaPath: 'de/def.mp3' });
    await store.insertTranscript(transcript, [
      seg({ id: 'S1', idx: 0, startMs: 0, endMs: 1000, language: 'en' }),
    ]);
    await store.insertTranscript({ ...transcript, id: 'T2', recordingId: 'R2' }, [
      seg({ id: 'S2', transcriptId: 'T2', idx: 0, startMs: 0, endMs: 1000, language: 'de' }),
    ]);
    expect(await store.languagesByTranscript(['T1', 'T2'])).toEqual(
      new Map([
        ['T1', ['en']],
        ['T2', ['de']],
      ]),
    );
    store.close();
  });
});

describe('SqliteStore', () => {
  it('migrates a fresh database to the current version', () => {
    const store = openStore(':memory:');
    expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
    store.close();
  });

  it('round-trips a recording', async () => {
    const store = openStore(':memory:');
    await store.insertRecording(recording);
    expect(await store.getRecording('R1')).toEqual(recording);
    expect(await store.findRecordingBySha('abc')).toEqual(recording);
    expect(await store.findRecordingBySha('nope')).toBeNull();
    store.close();
  });

  it('rejects a second recording with the same hash', async () => {
    const store = openStore(':memory:');
    await store.insertRecording(recording);
    await expect(store.insertRecording({ ...recording, id: 'R2' })).rejects.toThrow();
    store.close();
  });

  it('writes a transcript and its segments together', async () => {
    const store = openStore(':memory:');
    await store.insertRecording(recording);
    await store.insertTranscript(transcript, segments);
    expect(await store.latestTranscript('R1')).toEqual(transcript);
    expect(await store.listSegments('T1')).toEqual(segments);
    store.close();
  });

  it('leaves no transcript behind when a segment insert fails', async () => {
    const store = openStore(':memory:');
    await store.insertRecording(recording);
    const duplicated = [segments[0]!, { ...segments[1]!, idx: 0 }];
    await expect(store.insertTranscript(transcript, duplicated)).rejects.toThrow();
    expect(await store.latestTranscript('R1')).toBeNull();
    store.close();
  });

  it('returns the newest transcript per recording', async () => {
    const store = openStore(':memory:');
    await store.insertRecording(recording);
    await store.insertTranscript(transcript, segments);
    const newer: Transcript = {
      ...transcript,
      id: 'T2',
      createdAt: '2026-01-02T00:00:00.000Z',
      model: 'large-v3',
    };
    await store.insertTranscript(newer, []);
    expect((await store.latestTranscript('R1'))?.id).toBe('T2');
    store.close();
  });

  it('looks up a transcript by its own id', async () => {
    const store = openStore(':memory:');
    await store.insertRecording(recording);
    await store.insertTranscript(transcript, segments);
    expect(await store.getTranscript('T1')).toEqual(transcript);
    expect(await store.getTranscript('nope')).toBeNull();
    store.close();
  });

  it('lists recordings that have no transcript', async () => {
    const store = openStore(':memory:');
    await store.insertRecording(recording);
    await store.insertRecording({ ...recording, id: 'R2', sha256: 'def' });
    await store.insertTranscript(transcript, segments);
    const pending = await store.listRecordings({ withoutTranscript: true });
    expect(pending.map((r) => r.id)).toEqual(['R2']);
    store.close();
  });
});

describe('SqliteStore.deleteRecording', () => {
  it('removes the recording and reports it', async () => {
    const store = openStore(':memory:');
    await store.insertRecording(recording);
    expect(await store.deleteRecording('R1')).toBe(true);
    expect(await store.getRecording('R1')).toBeNull();
    store.close();
  });

  it('reports false for a recording that was never there', async () => {
    const store = openStore(':memory:');
    // Lets a caller tell "deleted" from "was not there" instead of guessing.
    expect(await store.deleteRecording('nope')).toBe(false);
    store.close();
  });

  it('takes transcripts and segments with it, through ON DELETE CASCADE', async () => {
    const store = openStore(':memory:');
    await store.insertRecording(recording);
    await store.insertTranscript(transcript, segments);
    await store.deleteRecording('R1');
    expect(await store.latestTranscript('R1')).toBeNull();
    expect(await store.getTranscript('T1')).toBeNull();
    expect(await store.listSegments('T1')).toEqual([]);
    store.close();
  });

  it('keeps the full-text index in step with a cascaded delete', async () => {
    // The subtle one, and the reason this test exists. segment_fts is a
    // separate virtual table kept in sync by AFTER INSERT/DELETE triggers on
    // segment. Rows removed by a foreign-key CASCADE rather than by a direct
    // DELETE still have to fire those triggers -- if they do not, the index
    // keeps pointing at rows that no longer exist and a search starts
    // returning deleted transcripts, silently, with no error anywhere.
    //
    // A file-backed database and a second raw connection, rather than a
    // helper on the store: this asserts an internal invariant, and adding a
    // production method to reach it would widen the store's surface for a
    // test's convenience.
    const dir = await mkdtemp(join(tmpdir(), 'laud-fts-'));
    const dbFile = join(dir, 'laud.db');
    const store = openStore(dbFile);
    await store.insertRecording(recording);
    await store.insertTranscript(transcript, segments);

    const inspector = new DatabaseSync(dbFile);
    const before = inspector.prepare('SELECT count(*) AS n FROM segment_fts').get() as {
      n: number;
    };
    expect(Number(before.n)).toBe(segments.length);

    await store.deleteRecording('R1');
    const after = inspector.prepare('SELECT count(*) AS n FROM segment_fts').get() as {
      n: number;
    };
    expect(Number(after.n)).toBe(0);

    inspector.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
});

describe('SqliteStore and the recording date', () => {
  it('round-trips a date read from the container', async () => {
    const store = openStore(':memory:');
    await store.insertRecording({ ...recording, recordedAt: '2024-03-15T10:23:45.000Z' });
    expect((await store.getRecording('R1'))?.recordedAt).toBe('2024-03-15T10:23:45.000Z');
    store.close();
  });

  it('round-trips the absence of one', async () => {
    const store = openStore(':memory:');
    await store.insertRecording({ ...recording, recordedAt: null });
    expect((await store.getRecording('R1'))?.recordedAt).toBeNull();
    store.close();
  });

  it('migrates a version 1 database without losing its rows', async () => {
    // The upgrade path real users take, rather than a fresh database. A
    // migration that dropped or rewrote existing recordings would be far
    // worse than one that failed outright, so this asserts the rows survive
    // and simply have no date of their own -- which is the truth: nothing
    // knows retroactively when they were recorded.
    const dir = await mkdtemp(join(tmpdir(), 'laud-migrate-'));
    const dbFile = join(dir, 'laud.db');

    const v1 = new DatabaseSync(dbFile);
    for (const statement of MIGRATIONS[0]!.statements) v1.exec(statement);
    v1.exec('PRAGMA user_version = 1');
    v1.prepare(
      `INSERT INTO recording
         (id, sha256, source_path, media_path, duration_ms, mime, title, notes, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'OLD1',
      'oldsha',
      '/in/old.mp3',
      'ol/oldsha.mp3',
      4242,
      'audio/mpeg',
      null,
      null,
      '2025-01-01T00:00:00.000Z',
    );
    v1.close();

    const store = openStore(dbFile);
    expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
    const migrated = await store.getRecording('OLD1');
    expect(migrated?.durationMs).toBe(4242);
    expect(migrated?.importedAt).toBe('2025-01-01T00:00:00.000Z');
    expect(migrated?.recordedAt).toBeNull();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
});

describe('SqliteStore and speaker names', () => {
  it('stores, replaces, and lists names in label order', async () => {
    const store = openStore(':memory:');
    await store.insertRecording(recording);
    await store.setSpeakerName('R1', 'speaker_01', 'Bob');
    await store.setSpeakerName('R1', 'speaker_00', 'Ann');
    await store.setSpeakerName('R1', 'speaker_00', 'Anna');
    expect(await store.listSpeakerNames('R1')).toEqual([
      { label: 'speaker_00', name: 'Anna' },
      { label: 'speaker_01', name: 'Bob' },
    ]);
    store.close();
  });

  it('keeps one recordings names out of anothers', async () => {
    const store = openStore(':memory:');
    await store.insertRecording(recording);
    await store.insertRecording({ ...recording, id: 'R2', sha256: 'def', mediaPath: 'de/def.mp3' });
    await store.setSpeakerName('R1', 'speaker_00', 'Ann');
    // The same label means a different person in a different file, which is
    // why the table is keyed on both.
    expect(await store.listSpeakerNames('R2')).toEqual([]);
    store.close();
  });

  it('takes names with the recording when it is deleted', async () => {
    const store = openStore(':memory:');
    await store.insertRecording(recording);
    await store.setSpeakerName('R1', 'speaker_00', 'Ann');
    await store.deleteRecording('R1');
    expect(await store.listSpeakerNames('R1')).toEqual([]);
    store.close();
  });

  it('sets title and notes independently, leaving the other alone', async () => {
    const store = openStore(':memory:');
    await store.insertRecording(recording);
    await store.annotateRecording('R1', { notes: 'context' });
    await store.annotateRecording('R1', { title: 'Standup' });
    const updated = await store.getRecording('R1');
    expect(updated?.notes).toBe('context');
    expect(updated?.title).toBe('Standup');
    store.close();
  });
});
