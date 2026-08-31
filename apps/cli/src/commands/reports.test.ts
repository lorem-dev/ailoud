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

describe('laud report ls / show', () => {
  it('says so when there are none, rather than printing an empty table', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await expect(buildProgram(ctx).parseAsync(['node', 'laud', 'report', 'ls'])).rejects.toThrow(
      FailureError,
    );
    await expect(buildProgram(ctx).parseAsync(['node', 'laud', 'report', 'ls'])).rejects.toThrow(
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
    await buildProgram(ctx).parseAsync(['node', 'laud', 'report', 'ls']);
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
    await buildProgram(ctx).parseAsync(['node', 'laud', 'report', 'show', 'SUM']);
    const out = ctx.lines.join('\n');
    expect(out).toContain('claude-cli haiku');
    expect(out).toContain('Covers: ID001');
    expect(out).toContain('Meet at the pier at five.');
  });

  it('takes an id prefix, like every other command', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await ctx.store.insertSummary(summary());
    ctx.lines.length = 0;
    await buildProgram(ctx).parseAsync(['node', 'laud', 'report', 'show', 'SUM0']);
    expect(ctx.lines.join('\n')).toContain('Meet at the pier at five.');
  });

  it('names the count and shows candidates when a prefix is ambiguous', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await ctx.store.insertSummary(summary({ id: 'SUM00000000000000000000001' }));
    await ctx.store.insertSummary(summary({ id: 'SUM00000000000000000000002' }));
    await expect(
      buildProgram(ctx).parseAsync(['node', 'laud', 'report', 'show', 'SUM']),
    ).rejects.toThrow(/matches 2 reports/);
  });

  it('refuses a prefix too short to mean anything', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await ctx.store.insertSummary(summary());
    await expect(
      buildProgram(ctx).parseAsync(['node', 'laud', 'report', 'show', 'S']),
    ).rejects.toThrow(UsageError);
  });

  it('says which report id did not match', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await expect(
      buildProgram(ctx).parseAsync(['node', 'laud', 'report', 'show', 'ZZZZ']),
    ).rejects.toThrow(/No report matches "ZZZZ"/);
  });

  it('filters to one recording, resolving its prefix too', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await ctx.store.insertSummary(summary({ recordingIds: ['ID001'] }));
    ctx.lines.length = 0;
    await buildProgram(ctx).parseAsync(['node', 'laud', 'report', 'ls', '--recording', 'ID0']);
    expect(ctx.lines.join('\n')).toContain('SUM00000000000000000000001');
  });

  it('emits JSON for machines, and an empty array rather than an error', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    ctx.lines.length = 0;
    await buildProgram(ctx).parseAsync(['node', 'laud', 'report', 'ls', '--json']);
    expect(ctx.lines.join('')).toContain('[]');

    await ctx.store.insertSummary(summary());
    ctx.lines.length = 0;
    await buildProgram(ctx).parseAsync(['node', 'laud', 'report', 'ls', '--json']);
    const parsed = JSON.parse(ctx.lines.join('')) as Summary[];
    expect(parsed[0]!.model).toBe('haiku');
    expect(parsed[0]!.recordingIds).toEqual(['ID001']);
  });

  it('shows a group report as a count rather than a wall of ids', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await ctx.store.insertSummary(summary({ recordingIds: ['ID001', 'ID002', 'ID003'] }));
    ctx.lines.length = 0;
    await buildProgram(ctx).parseAsync(['node', 'laud', 'report', 'ls']);
    expect(ctx.lines.join('\n')).toContain('3 recordings');
  });
});

describe('laud report rm', () => {
  const stored = async (ctx: Awaited<ReturnType<typeof contextWithTranscript>>) => {
    await ctx.store.insertSummary(summary({ id: 'SUM00000000000000000000001' }));
    await ctx.store.insertSummary(summary({ id: 'SUM00000000000000000000002' }));
  };

  it('deletes the report and leaves the recording and its transcript alone', async () => {
    // A report is derived; what it was derived from is the library itself.
    const ctx = await contextWithTranscript({ clearLines: true });
    await stored(ctx);
    await buildProgram(ctx).parseAsync([
      'node',
      'laud',
      'report',
      'rm',
      'SUM00000000000000000000001',
      '--force',
    ]);
    expect((await ctx.store.listAllSummaries()).map((s) => s.id)).toEqual([
      'SUM00000000000000000000002',
    ]);
    expect(await ctx.store.getRecording('ID001')).not.toBeNull();
    expect(await ctx.store.latestTranscript('ID001')).not.toBeNull();
  });

  it('says what it is about to delete before asking', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await stored(ctx);
    ctx.lines.length = 0;
    await buildProgram(ctx).parseAsync([
      'node',
      'laud',
      'report',
      'rm',
      'SUM00000000000000000000001',
      '--force',
    ]);
    const out = ctx.lines.join('\n');
    expect(out).toContain('permanently delete 1 report');
    expect(out).toContain('not touched');
  });

  it('refuses without a terminal and names the command the user typed', async () => {
    // Naming plain "rm" would send someone to the command that deletes
    // recordings -- the drift CommandName exists to prevent.
    const ctx = await contextWithTranscript({ clearLines: true });
    await stored(ctx);
    await expect(
      buildProgram(ctx).parseAsync(['node', 'laud', 'report', 'rm', 'SUM00000000000000000000001']),
    ).rejects.toThrow(/laud report rm needs confirmation/);
  });

  it('changes nothing when the confirmation is refused', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await stored(ctx);
    await expect(
      buildProgram(ctx).parseAsync(['node', 'laud', 'report', 'rm', 'SUM00000000000000000000001']),
    ).rejects.toThrow();
    expect(await ctx.store.listAllSummaries()).toHaveLength(2);
  });

  it('resolves every id before deleting any of them', async () => {
    // Half a deletion is the worst outcome: the user asked about a set.
    const ctx = await contextWithTranscript({ clearLines: true });
    await stored(ctx);
    await expect(
      buildProgram(ctx).parseAsync([
        'node',
        'laud',
        'report',
        'rm',
        'SUM00000000000000000000001',
        'ZZZZ',
        '--force',
      ]),
    ).rejects.toThrow(/No report matches/);
    expect(await ctx.store.listAllSummaries()).toHaveLength(2);
  });
});

describe('command layout', () => {
  it('keeps the old spellings working, so hands and scripts do not break', async () => {
    // The same bargain docker struck: `docker ps` still works years after
    // `docker container ls` became canonical.
    for (const argv of [
      ['node', 'laud', 'ls'],
      ['node', 'laud', 'audio', 'ls'],
      ['node', 'laud', 'recordings', 'ls'],
    ]) {
      const ctx = await contextWithTranscript({ clearLines: true });
      await buildProgram(ctx).parseAsync(argv);
      expect(ctx.lines.join('\n'), argv.join(' ')).toContain('ID001');
    }
  });

  it('lists the groups but not the aliased commands in the top-level help', async () => {
    const ctx = await contextWithTranscript({ skipImport: true });
    const help = buildProgram(ctx).helpInformation();
    expect(help).toContain('audio|recordings');
    expect(help).toContain('report|reports');
    // Hidden, so the top-level help shows the shape of the tool rather than
    // every command twice.
    expect(help).not.toMatch(/^\s+ls\b/m);
    expect(help).not.toMatch(/^\s+annotate\b/m);
  });

  it('answers a bare group with its verbs rather than an error', async () => {
    const ctx = await contextWithTranscript({ skipImport: true });
    const audio = buildProgram(ctx).commands.find((c) => c.name() === 'audio');
    const verbs = audio?.commands.map((c) => c.name()) ?? [];
    expect(verbs).toEqual(expect.arrayContaining(['ls', 'show', 'annotate', 'rm']));
  });
});
