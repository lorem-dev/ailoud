import { describe, expect, it } from 'vitest';
import { FailureError, UsageError } from '@laud/core';
import type { Summary } from '@laud/core';
import { buildProgram } from '../program.js';
import { contextWithTranscript } from './testContext.js';
import { reportPreview } from './reports.js';

const summary = (over: Partial<Summary> = {}): Summary => ({
  id: 'SUM00000000000000000000001',
  createdAt: '2026-08-31T10:53:09.010Z',
  language: 'en',
  provider: 'claude-cli',
  model: 'haiku',
  body: '**Decisions**\n- Meet at the pier at five.\n',
  recordingIds: ['ID001'],
  ...over,
});

describe('reportPreview', () => {
  it('skips the heading and shows the first real line', () => {
    expect(reportPreview(summary().body)).toBe('Meet at the pier at five.');
  });

  it('skips a heading in any language', () => {
    // A list of English heading names let "Решения" straight through, and the
    // listing showed that one word as the preview of every Russian report.
    expect(reportPreview('**Решения**\n- Встреча в пять.\n')).toBe('Встреча в пять.');
    expect(reportPreview('## Entscheidungen\n- Treffen um fünf.\n')).toBe('Treffen um fünf.');
  });

  it('keeps a bold run that is only part of a line', () => {
    // Wholly-bold is a heading; bold inside a sentence is emphasis.
    expect(reportPreview('- We **must** leave at five.\n')).toBe('We must leave at five.');
  });

  it('marks a clipped preview so it is not read as the whole line', () => {
    const long = `- ${'word '.repeat(40).trim()}`;
    expect(reportPreview(long)).toMatch(/\.\.\.$/);
  });

  it('clips by code point, never splitting a character in half', () => {
    const preview = reportPreview(`- ${'\u{1F600}'.repeat(80)}`, 4);
    expect([...preview.replace('...', '')]).toHaveLength(4);
  });

  it('returns empty for a report that is nothing but headings', () => {
    expect(reportPreview('**Decisions**\n\n**Notes**\n')).toBe('');
  });
});

describe('laud reports', () => {
  it('says so when there are none, rather than printing an empty table', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await expect(buildProgram(ctx).parseAsync(['node', 'laud', 'reports'])).rejects.toThrow(
      FailureError,
    );
    await expect(buildProgram(ctx).parseAsync(['node', 'laud', 'reports'])).rejects.toThrow(
      /No reports yet/,
    );
  });

  it('lists what produced each report, newest first', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await ctx.store.insertSummary(summary({ id: 'SUM00000000000000000000001' }));
    await ctx.store.insertSummary(
      summary({ id: 'SUM00000000000000000000002', createdAt: '2026-08-31T11:00:00.000Z' }),
    );
    ctx.lines.length = 0;
    await buildProgram(ctx).parseAsync(['node', 'laud', 'reports']);
    const out = ctx.lines.join('\n');
    expect(out).toContain('haiku');
    expect(out.indexOf('SUM00000000000000000000002')).toBeLessThan(
      out.indexOf('SUM00000000000000000000001'),
    );
  });

  it('prints one report in full, with what made it', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await ctx.store.insertSummary(summary());
    ctx.lines.length = 0;
    await buildProgram(ctx).parseAsync(['node', 'laud', 'reports', 'SUM']);
    const out = ctx.lines.join('\n');
    expect(out).toContain('claude-cli haiku');
    expect(out).toContain('Covers: ID001');
    expect(out).toContain('Meet at the pier at five.');
  });

  it('takes an id prefix, like every other command', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await ctx.store.insertSummary(summary());
    ctx.lines.length = 0;
    await buildProgram(ctx).parseAsync(['node', 'laud', 'reports', 'SUM0']);
    expect(ctx.lines.join('\n')).toContain('Meet at the pier at five.');
  });

  it('names the count and shows candidates when a prefix is ambiguous', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await ctx.store.insertSummary(summary({ id: 'SUM00000000000000000000001' }));
    await ctx.store.insertSummary(summary({ id: 'SUM00000000000000000000002' }));
    await expect(buildProgram(ctx).parseAsync(['node', 'laud', 'reports', 'SUM'])).rejects.toThrow(
      /matches 2 reports/,
    );
  });

  it('refuses a prefix too short to mean anything', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await ctx.store.insertSummary(summary());
    await expect(buildProgram(ctx).parseAsync(['node', 'laud', 'reports', 'S'])).rejects.toThrow(
      UsageError,
    );
  });

  it('says which report id did not match', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await expect(buildProgram(ctx).parseAsync(['node', 'laud', 'reports', 'ZZZZ'])).rejects.toThrow(
      /No report matches "ZZZZ"/,
    );
  });

  it('filters to one recording, resolving its prefix too', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await ctx.store.insertSummary(summary({ recordingIds: ['ID001'] }));
    ctx.lines.length = 0;
    await buildProgram(ctx).parseAsync(['node', 'laud', 'reports', '--recording', 'ID0']);
    expect(ctx.lines.join('\n')).toContain('SUM00000000000000000000001');
  });

  it('emits JSON for machines, and an empty array rather than an error', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    ctx.lines.length = 0;
    await buildProgram(ctx).parseAsync(['node', 'laud', 'reports', '--json']);
    expect(ctx.lines.join('')).toContain('[]');

    await ctx.store.insertSummary(summary());
    ctx.lines.length = 0;
    await buildProgram(ctx).parseAsync(['node', 'laud', 'reports', '--json']);
    const parsed = JSON.parse(ctx.lines.join('')) as Summary[];
    expect(parsed[0]!.model).toBe('haiku');
    expect(parsed[0]!.recordingIds).toEqual(['ID001']);
  });

  it('shows a group report as a count rather than a wall of ids', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await ctx.store.insertSummary(summary({ recordingIds: ['ID001', 'ID002', 'ID003'] }));
    ctx.lines.length = 0;
    await buildProgram(ctx).parseAsync(['node', 'laud', 'reports']);
    expect(ctx.lines.join('\n')).toContain('3 recordings');
  });
});
