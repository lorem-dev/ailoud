import { describe, expect, it } from 'vitest';
import { FailureError, UsageError } from '@ailoud/core';
import { buildProgram } from '../program.js';
import { contextWithTranscript } from './testContext.js';
import { parseLimit } from './search.js';

describe('parseLimit', () => {
  it('defaults to something a person can read', () => {
    expect(parseLimit(undefined)).toBe(50);
  });

  it('refuses a limit that is not a whole positive number', () => {
    for (const bad of ['0', '-1', 'lots', '1.5', '99999']) {
      expect(() => parseLimit(bad), bad).toThrow(FailureError);
    }
  });

  it('takes a number in range', () => {
    expect(parseLimit('200')).toBe(200);
  });
});

describe('ailoud audio search', () => {
  it('finds a phrase and says where it was said', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'audio', 'search', 'Privet']);
    const out = ctx.lines.join('\n');
    expect(out).toContain('ID001');
    expect(out).toContain('Privet.');
    // A timestamp, so the answer to "where" is usable.
    expect(out).toMatch(/\[\d\d:\d\d(:\d\d)?\]/);
  });

  it('returns segments, never the whole transcript', async () => {
    // The whole point: "where was this discussed" is answered by a line and a
    // timestamp, not by a thousand lines to read through.
    const ctx = await contextWithTranscript({ clearLines: true });
    const transcript = await ctx.store.latestTranscript('ID001');
    await ctx.store.insertTranscript(
      { ...transcript!, id: 'TR2', createdAt: '2026-08-31T12:00:00.000Z' },
      Array.from({ length: 30 }, (_, i) => ({
        id: `S${i}`,
        transcriptId: 'TR2',
        idx: i,
        startMs: i * 1000,
        endMs: i * 1000 + 900,
        text: i === 7 ? 'the needle is here' : `filler line ${i}`,
        speaker: null,
        language: 'en',
      })),
    );
    ctx.lines.length = 0;
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'audio', 'search', 'needle']);
    const out = ctx.lines.join('\n');
    expect(out).toContain('the needle is here');
    expect(out).not.toContain('filler line 3');
  });

  it('searches only the newest transcript by default', async () => {
    // A recording re-transcribed with --force has several holding the same
    // words; searching all of them reads as several occurrences.
    const ctx = await contextWithTranscript({ clearLines: true });
    const transcript = await ctx.store.latestTranscript('ID001');
    await ctx.store.insertTranscript(
      { ...transcript!, id: 'TR2', createdAt: '2026-08-31T12:00:00.000Z' },
      [
        {
          id: 'S-NEW',
          transcriptId: 'TR2',
          idx: 0,
          startMs: 0,
          endMs: 900,
          text: 'Privet again',
          speaker: null,
          language: 'en',
        },
      ],
    );
    ctx.lines.length = 0;
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'audio', 'search', 'Privet']);
    expect(ctx.lines.join('\n')).toContain('1 hit');

    ctx.lines.length = 0;
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'audio', 'search', 'Privet', '--all']);
    expect(ctx.lines.join('\n')).toContain('2 hits');
  });

  it('shows the tags in the heading, so "which context" needs no second command', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await ctx.store.addTags('ID001', ['standup']);
    ctx.lines.length = 0;
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'audio', 'search', 'Privet']);
    expect(ctx.lines.join('\n')).toContain('[standup]');
  });

  it('says "no tags" rather than an empty bracket', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'audio', 'search', 'Privet']);
    expect(ctx.lines.join('\n')).toContain('[no tags]');
  });

  it('narrows by tag, requiring all of them', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await ctx.store.addTags('ID001', ['standup']);
    ctx.lines.length = 0;
    await buildProgram(ctx).parseAsync([
      'node',
      'ailoud',
      'audio',
      'search',
      'Privet',
      '--tag',
      'standup',
    ]);
    expect(ctx.lines.join('\n')).toContain('ID001');

    await expect(
      buildProgram(ctx).parseAsync([
        'node',
        'ailoud',
        'audio',
        'search',
        'Privet',
        '--tag',
        'standup',
        '--tag',
        'absent',
      ]),
    ).rejects.toThrow(/Nothing matches/);
  });

  it('narrows to one recording, resolving its prefix', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await buildProgram(ctx).parseAsync([
      'node',
      'ailoud',
      'audio',
      'search',
      'Privet',
      '--recording',
      'ID0',
    ]);
    expect(ctx.lines.join('\n')).toContain('ID001');
  });

  it('says so when nothing matches, naming what was looked for', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await expect(
      buildProgram(ctx).parseAsync(['node', 'ailoud', 'audio', 'search', 'zebra']),
    ).rejects.toThrow(/Nothing matches "zebra"/);
  });

  it('refuses a query with nothing in it', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await expect(
      buildProgram(ctx).parseAsync(['node', 'ailoud', 'audio', 'search', '   ']),
    ).rejects.toThrow(UsageError);
  });

  it('emits JSON for machines, empty array included', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'audio', 'search', 'zebra', '--json']);
    expect(ctx.lines.join('')).toBe('[]');

    ctx.lines.length = 0;
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'audio', 'search', 'Privet', '--json']);
    const parsed = JSON.parse(ctx.lines.join('')) as { text: string; startMs: number }[];
    expect(parsed[0]!.text).toContain('Privet');
    expect(typeof parsed[0]!.startMs).toBe('number');
  });

  it('never caps silently', async () => {
    // A listing that stops at the limit and says nothing reads as "that is
    // all there is".
    const ctx = await contextWithTranscript({ clearLines: true });
    await buildProgram(ctx).parseAsync([
      'node',
      'ailoud',
      'audio',
      'search',
      'Privet',
      '--limit',
      '1',
    ]);
    expect(ctx.lines.join('\n')).toContain('Stopped at 1 hits');
  });

  it('answers to its letter', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'audio', 'f', 'Privet']);
    expect(ctx.lines.join('\n')).toContain('ID001');
  });
});
