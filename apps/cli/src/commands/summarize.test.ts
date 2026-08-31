import { describe, expect, it } from 'vitest';
import { UsageError } from '@laud/core';
import type { Summarizer } from '@laud/core';
import { buildProgram } from '../program.js';
import { contextWithTranscript } from './testContext.js';
import { transcriptBudget } from './summarize.js';

const summarizer = (contextTokens: number): Summarizer => ({
  name: 'fake',
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
