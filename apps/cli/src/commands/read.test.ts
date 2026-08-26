import { describe, expect, it } from 'vitest';
import type { Recording, Segment, Transcript } from '@laud/core';
import { buildProgram } from '../program.js';
import { context, contextWithTranscript } from './testContext.js';

describe('laud ls', () => {
  it('prints one line per recording with its state', async () => {
    const ctx = await contextWithTranscript();
    await buildProgram(ctx).parseAsync(['node', 'laud', 'ls']);
    expect(ctx.lines.at(-1)).toBe('ID001  00:00:03  ru  Privet.');
  });

  it('emits machine-readable rows with --json', async () => {
    const ctx = await contextWithTranscript();
    await buildProgram(ctx).parseAsync(['node', 'laud', 'ls', '--json']);
    const rows = JSON.parse(ctx.lines.at(-1)!);
    expect(rows[0]).toMatchObject({ id: 'ID001', language: 'ru', durationMs: 3200 });
  });

  it('says the library is empty rather than printing nothing', async () => {
    const ctx = await contextWithTranscript({ skipImport: true });
    await buildProgram(ctx).parseAsync(['node', 'laud', 'ls']);
    expect(ctx.lines).toEqual(['The library is empty. Add something with "laud import".']);
  });

  it('prints a valid empty JSON array with --json on an empty library', async () => {
    const ctx = await contextWithTranscript({ skipImport: true });
    await buildProgram(ctx).parseAsync(['node', 'laud', 'ls', '--json']);
    expect(JSON.parse(ctx.lines.at(-1)!)).toEqual([]);
  });

  it('still lists a recording that has not been transcribed yet', async () => {
    const ctx = await contextWithTranscript({ skipTranscribe: true, clearLines: true });
    await buildProgram(ctx).parseAsync(['node', 'laud', 'ls']);
    expect(ctx.lines).toEqual(['ID001  00:00:03']);
  });

  it('carries null language and transcriptId with --json for an untranscribed recording', async () => {
    const ctx = await contextWithTranscript({ skipTranscribe: true, clearLines: true });
    await buildProgram(ctx).parseAsync(['node', 'laud', 'ls', '--json']);
    const rows = JSON.parse(ctx.lines.at(-1)!);
    expect(rows[0]).toMatchObject({ id: 'ID001', language: null, transcriptId: null });
  });

  it('keeps an astral-plane character intact when it straddles the preview boundary', async () => {
    const ctx = context();
    const emoji = '\u{1F600}'; // outside the BMP: a UTF-16 surrogate pair
    const text = `${'a'.repeat(59)}${emoji}${'b'.repeat(10)}`;
    const recording: Recording = {
      id: 'ID001',
      sha256: 'sha-x',
      sourcePath: '/in/x.mp3',
      mediaPath: 'sh/x.mp3',
      durationMs: 1000,
      mime: 'audio/mpeg',
      title: null,
      notes: null,
      importedAt: '2026-01-01T00:00:00.000Z',
    };
    await ctx.store.insertRecording(recording);
    const transcript: Transcript = {
      id: 'T1',
      recordingId: 'ID001',
      provider: 'fake',
      model: 'base.bin',
      language: 'en',
      text,
      createdAt: '2026-01-01T00:00:01.000Z',
    };
    const segment: Segment = {
      id: 'S1',
      transcriptId: 'T1',
      idx: 0,
      startMs: 0,
      endMs: 500,
      text,
      speaker: null,
      language: null,
    };
    await ctx.store.insertTranscript(transcript, [segment]);

    await buildProgram(ctx).parseAsync(['node', 'laud', 'ls']);
    // 59 plain characters plus the whole (unsplit) emoji is 60 code points;
    // a naive UTF-16 slice would instead land mid-surrogate-pair here.
    const expectedPreview = `${'a'.repeat(59)}${emoji}`;
    expect(ctx.lines.at(-1)).toBe(`ID001  00:00:01  en  ${expectedPreview}`);
  });
});

describe('laud show', () => {
  it('prints timestamped text by default', async () => {
    const ctx = await contextWithTranscript();
    await buildProgram(ctx).parseAsync(['node', 'laud', 'show', 'ID001']);
    expect(ctx.lines.at(-1)).toContain('[00:00:00] Privet.');
  });

  it('prints SRT with --format srt', async () => {
    const ctx = await contextWithTranscript();
    await buildProgram(ctx).parseAsync(['node', 'laud', 'show', 'ID001', '--format', 'srt']);
    expect(ctx.lines.at(-1)).toContain('00:00:00,000 --> 00:00:01,500');
  });

  it('round-trips through JSON with the recording, transcript, and segments', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await buildProgram(ctx).parseAsync(['node', 'laud', 'show', 'ID001', '--format', 'json']);
    const parsed = JSON.parse(ctx.lines.at(-1)!);
    expect(parsed.recording.id).toBe('ID001');
    expect(parsed.transcript.recordingId).toBe('ID001');
    expect(parsed.segments).toHaveLength(1);

    await buildProgram(ctx).parseAsync(['node', 'laud', 'ls', '--json']);
    const rows = JSON.parse(ctx.lines.at(-1)!);
    expect(rows[0].transcriptId).toBe(parsed.transcript.id);
  });

  it('fails with a clear message for an unknown id', async () => {
    const ctx = await contextWithTranscript();
    await expect(buildProgram(ctx).parseAsync(['node', 'laud', 'show', 'NOPE'])).rejects.toThrow(
      /No recording with id NOPE/,
    );
  });

  it('fails when the recording has no transcript yet', async () => {
    const ctx = await contextWithTranscript({ skipTranscribe: true });
    await expect(buildProgram(ctx).parseAsync(['node', 'laud', 'show', 'ID001'])).rejects.toThrow(
      /has no transcript/,
    );
  });

  it('rejects an unknown format by listing the valid ones', async () => {
    const ctx = await contextWithTranscript();
    await expect(
      buildProgram(ctx).parseAsync(['node', 'laud', 'show', 'ID001', '--format', 'pdf']),
    ).rejects.toThrow(/text, json, srt, vtt/);
  });

  it('selects a specific transcript by id instead of the newest', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    const original = await ctx.store.latestTranscript('ID001');
    const newer: Transcript = {
      ...original!,
      id: 'NEWER',
      language: 'en',
      text: 'Hello.',
      createdAt: '2026-01-01T00:10:00.000Z',
    };
    const newerSegment: Segment = {
      id: 'NEWSEG',
      transcriptId: 'NEWER',
      idx: 0,
      startMs: 0,
      endMs: 500,
      text: 'Hello.',
      speaker: null,
      language: null,
    };
    await ctx.store.insertTranscript(newer, [newerSegment]);

    await buildProgram(ctx).parseAsync(['node', 'laud', 'show', 'ID001']);
    expect(ctx.lines.at(-1)).toContain('Hello.');

    await buildProgram(ctx).parseAsync([
      'node',
      'laud',
      'show',
      'ID001',
      '--transcript',
      original!.id,
    ]);
    expect(ctx.lines.at(-1)).toContain('Privet.');
  });

  it('refuses a --transcript id that belongs to a different recording', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    const other: Recording = {
      id: 'OTHER',
      sha256: 'other-sha',
      sourcePath: '/in/b.mp3',
      mediaPath: 'ot/other.mp3',
      durationMs: 1000,
      mime: 'audio/mpeg',
      title: null,
      notes: null,
      importedAt: '2026-01-01T00:00:05.000Z',
    };
    await ctx.store.insertRecording(other);
    const foreignTranscript: Transcript = {
      id: 'FOREIGN',
      recordingId: 'OTHER',
      provider: 'fake',
      model: 'base.bin',
      language: 'en',
      text: 'Hello.',
      createdAt: '2026-01-01T00:00:06.000Z',
    };
    const foreignSegment: Segment = {
      id: 'FSEG',
      transcriptId: 'FOREIGN',
      idx: 0,
      startMs: 0,
      endMs: 500,
      text: 'Hello.',
      speaker: null,
      language: null,
    };
    await ctx.store.insertTranscript(foreignTranscript, [foreignSegment]);

    await expect(
      buildProgram(ctx).parseAsync(['node', 'laud', 'show', 'ID001', '--transcript', 'FOREIGN']),
    ).rejects.toThrow(/not a transcript of recording ID001/);
  });
});
