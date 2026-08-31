import { describe, expect, it } from 'vitest';
import { UsageError } from '@laud/core';
import type { Summarizer } from '@laud/core';
import { buildProgram } from '../program.js';
import { contextWithTranscript } from './testContext.js';
import type { MemFs } from '@laud/core/testing';
import { transcriptBudget } from './summarize.js';

const summarizer = (contextTokens: number): Summarizer => ({
  name: 'fake',
  model: 'fake-model',
  contextTokens,
  complete: async () => 'x',
});

describe('transcriptBudget', () => {
  it('leaves room for the instruction and the answer', () => {
    // The transcript is not alone in the window: the prompt goes in front of
    // it and the summary has to come out.
    expect(transcriptBudget(summarizer(9000))).toBeLessThan(9000);
  });

  it('errs toward reserving too much rather than too little', () => {
    // Overshooting means the model is handed more than it holds and says so
    // only after the work is done; undershooting costs one extra chunk.
    expect(transcriptBudget(summarizer(9000))).toBeLessThanOrEqual(6000);
  });

  it('never returns a budget too small to hold anything', () => {
    expect(transcriptBudget(summarizer(1))).toBeGreaterThanOrEqual(256);
  });
});

describe('laud summarize', () => {
  it('summarises a recording', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await buildProgram(ctx).parseAsync(['node', 'laud', 'summarize', 'ID001']);
    expect(ctx.lines.join('\n')).toContain('a summary');
  });

  it('puts the transcript, with speaker names, into the prompt', async () => {
    // The reason annotate exists: the model should attribute points to a
    // person, not to "speaker_00".
    const ctx = await contextWithTranscript({ clearLines: true });
    await buildProgram(ctx).parseAsync(['node', 'laud', 'summarize', 'ID001']);
    const prompt = ctx.summarizerPrompts[0] ?? '';
    expect(prompt).toContain('Privet.');
    expect(prompt).toMatch(/language the transcript is in/);
  });

  it('refuses to summarise the whole library by accident', async () => {
    // Minutes of local inference, or real money on a hosted model. Unlike
    // transcribe, there is deliberately no default selection.
    const ctx = await contextWithTranscript({ clearLines: true });
    await expect(buildProgram(ctx).parseAsync(['node', 'laud', 'summarize'])).rejects.toThrow(
      UsageError,
    );
    await expect(buildProgram(ctx).parseAsync(['node', 'laud', 'summarize'])).rejects.toThrow(
      /needs recording ids or --tag/,
    );
  });

  it('refuses ids and --tag together', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await expect(
      buildProgram(ctx).parseAsync(['node', 'laud', 'summarize', 'ID001', '--tag', 'x']),
    ).rejects.toThrow(/not both/);
  });

  it('says which recording has no transcript rather than summarising nothing', async () => {
    const ctx = await contextWithTranscript({ skipTranscribe: true, clearLines: true });
    await expect(
      buildProgram(ctx).parseAsync(['node', 'laud', 'summarize', 'ID001']),
    ).rejects.toThrow(/has no transcript yet/);
  });

  it('says so when a tag matches nothing', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await expect(
      buildProgram(ctx).parseAsync(['node', 'laud', 'summarize', '--tag', 'nothing']),
    ).rejects.toThrow(/No recordings carry/);
  });

  it('summarises a tagged group together, in one request', async () => {
    // "What came out of these conversations" is a different question from
    // three separate answers, which the user can already get by running the
    // command three times.
    const ctx = await contextWithTranscript({ clearLines: true });
    await buildProgram(ctx).parseAsync(['node', 'laud', 'annotate', 'ID001', '--tag', 'standup']);
    ctx.summarizerPrompts.length = 0;
    await buildProgram(ctx).parseAsync(['node', 'laud', 'summarize', '--tag', 'standup']);
    expect(ctx.summarizerPrompts).toHaveLength(1);
  });

  it('takes an id prefix like every other command', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await buildProgram(ctx).parseAsync(['node', 'laud', 'summarize', 'ID0']);
    expect(ctx.lines.join('\n')).toContain('a summary');
  });
});

describe('laud summarize --lang', () => {
  it('names the language, not the code, in the prompt', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await buildProgram(ctx).parseAsync(['node', 'laud', 'summarize', 'ID001', '--lang', 'ru']);
    expect(ctx.summarizerPrompts[0]).toContain('Write in Russian.');
  });

  it('leaves the language to the transcript when not asked', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await buildProgram(ctx).parseAsync(['node', 'laud', 'summarize', 'ID001']);
    expect(ctx.summarizerPrompts[0]).toContain('the language the transcript is in');
  });
});

describe('laud summarize: what it keeps', () => {
  it('stores the summary with what produced it', async () => {
    // The model and language are the point: a summary later reused as context
    // is worth less if nobody can tell what wrote it or in what language.
    const ctx = await contextWithTranscript({ clearLines: true });
    await buildProgram(ctx).parseAsync(['node', 'laud', 'summarize', 'ID001', '--lang', 'en']);
    const stored = await ctx.store.listSummaries('ID001');
    expect(stored).toHaveLength(1);
    expect(stored[0]!.model).toBe('fake-model');
    expect(stored[0]!.language).toBe('en');
    expect(stored[0]!.recordingIds).toEqual(['ID001']);
  });

  it('does not store anything with --no-save', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await buildProgram(ctx).parseAsync(['node', 'laud', 'summarize', 'ID001', '--no-save']);
    expect(await ctx.store.listSummaries('ID001')).toEqual([]);
  });

  it('never re-summarises its own summary of a single recording', async () => {
    // A summary of a summary is a game of telephone: each pass is further
    // from what anybody actually said. Asking again about one recording, or
    // asking in another language, has to go back to the transcript.
    const ctx = await contextWithTranscript({ clearLines: true });
    await buildProgram(ctx).parseAsync(['node', 'laud', 'summarize', 'ID001']);
    ctx.summarizerPrompts.length = 0;
    await buildProgram(ctx).parseAsync(['node', 'laud', 'summarize', 'ID001', '--lang', 'ru']);
    expect(ctx.summarizerPrompts[0]).toContain('Privet.');
    expect(ctx.summarizerPrompts[0]).not.toMatch(/earlier summary/i);
  });

  it('reuses stored summaries for a group, where they actually pay', async () => {
    // Ten meetings summarised from ten stored summaries costs a fraction of
    // ten transcripts, and the map step has already been paid for once.
    const ctx = await contextWithTranscript({ clearLines: true });
    const first = (await ctx.store.listRecordings({}))[0]!;
    await ctx.store.insertRecording({ ...first, id: 'ID002', sha256: 'other' });
    for (const id of ['ID001', 'ID002']) {
      await ctx.store.insertSummary({
        id: `SUM-${id}`,
        createdAt: '2026-08-31T00:00:00.000Z',
        language: 'en',
        provider: 'fake',
        model: 'fake-model',
        body: `summary of ${id}`,
        recordingIds: [id],
      });
      await ctx.store.addTags(id, ['group']);
    }
    ctx.summarizerPrompts.length = 0;
    ctx.lines.length = 0;
    await buildProgram(ctx).parseAsync(['node', 'laud', 'summarize', '--tag', 'group']);
    expect(ctx.summarizerPrompts[0]).toMatch(/earlier summary/i);
    expect(ctx.summarizerPrompts[0]).toContain('summary of ID001');
    expect(ctx.lines.join('\n')).toMatch(/Reusing \d+ stored/);
  });

  it('reads the transcripts again with --fresh', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await ctx.store.insertSummary({
      id: 'SUM-1',
      createdAt: '2026-08-31T00:00:00.000Z',
      language: 'en',
      provider: 'fake',
      model: 'fake-model',
      body: 'stored',
      recordingIds: ['ID001'],
    });
    await buildProgram(ctx).parseAsync(['node', 'laud', 'summarize', 'ID001', '--fresh']);
    expect(ctx.summarizerPrompts[0]).toContain('Privet.');
  });

  it('does not offer a group summary as the summary of one recording in it', async () => {
    // A group summary of several meetings is not a summary of any one of them,
    // and reusing it as though it were would answer a question about one
    // recording with the others mixed in.
    const ctx = await contextWithTranscript({ clearLines: true });
    await ctx.store.insertSummary({
      id: 'SUM-GROUP',
      createdAt: '2026-08-31T00:00:00.000Z',
      language: 'en',
      provider: 'fake',
      model: 'fake-model',
      body: 'group summary',
      recordingIds: ['ID001', 'ID002'],
    });
    expect(await ctx.store.latestSummaryOf('ID001')).toBeNull();
  });
});

describe('laud summarize: the transcript files', () => {
  it('writes one file per recording, named from its date, into a directory it then removes', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    const written: string[] = [];
    const realWrite = ctx.fs.writeTextFile.bind(ctx.fs);
    ctx.fs.writeTextFile = async (path: string, content: string) => {
      written.push(path);
      return realWrite(path, content);
    };
    await buildProgram(ctx).parseAsync(['node', 'laud', 'summarize', 'ID001', '--fresh']);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/record-\d{14}\.txt$/);
    // Gone afterwards: the files exist for the run and no longer.
    expect([...(ctx.fs as MemFs).files.keys()].filter((p) => p.includes('record-'))).toEqual([]);
  });

  it('removes the directory even when the model fails', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    ctx.createSummarizer = () => ({
      name: 'fake',
      model: 'fake-model',
      contextTokens: 8192,
      complete: async () => {
        throw new Error('model exploded');
      },
    });
    await expect(
      buildProgram(ctx).parseAsync(['node', 'laud', 'summarize', 'ID001']),
    ).rejects.toThrow(/model exploded/);
    expect([...(ctx.fs as MemFs).files.keys()].filter((p) => p.includes('record-'))).toEqual([]);
  });
});

describe('laud summarize: progress', () => {
  it('counts each portion and the combining pass', async () => {
    // The reduce pass is counted with the portions: a bar that reaches 100%
    // and then keeps spinning is worse than one that reaches 90%.
    const ctx = await contextWithTranscript({ clearLines: true });
    // A transcript long enough to need portioning. transcriptBudget floors at
    // 256 tokens whatever the model claims, so shrinking the context alone
    // cannot force a split -- the material has to be genuinely long.
    const transcript = await ctx.store.latestTranscript('ID001');
    await ctx.store.insertTranscript(
      { ...transcript!, id: 'TR-LONG', createdAt: '2026-08-31T12:00:00.000Z' },
      Array.from({ length: 120 }, (_, i) => ({
        id: `SEG-${i}`,
        transcriptId: 'TR-LONG',
        idx: i,
        startMs: i * 1000,
        endMs: i * 1000 + 900,
        text: `line ${i} ${'word '.repeat(20).trim()}`,
        speaker: 'speaker_00',
        language: 'en',
      })),
    );
    ctx.createSummarizer = () => ({
      name: 'fake',
      model: 'fake-model',
      contextTokens: 400,
      complete: async () => 'partial',
    });
    await buildProgram(ctx).parseAsync(['node', 'laud', 'summarize', 'ID001', '--fresh']);
    const progress = ctx.lines.filter((line) => /\(\d+%\)/.test(line));
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toMatch(/^Combining portions/);
    // Never claims to be finished while a request is still outstanding.
    expect(progress.join('\n')).not.toContain('(100%)');
  });

  it('claims no percentage when there is only one request', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await buildProgram(ctx).parseAsync(['node', 'laud', 'summarize', 'ID001', '--fresh']);
    expect(ctx.lines.filter((line) => /%\)/.test(line))).toEqual([]);
  });
});
