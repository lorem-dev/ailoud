import { afterEach, describe, expect, it, vi } from 'vitest';
import { FailureError, UsageError } from '@ailoud/core';
import type { Summarizer } from '@ailoud/core';
import { buildProgram } from '../program.js';
import { contextWithTranscript, withRealDataDir } from './testContext.js';
import type { MemFs } from '@ailoud/core/testing';
import { transcriptBudget } from './summarize.js';
import { createJob, getJob, listJobs } from '../jobs/store.js';
import { withJobLock } from '../jobs/lock.js';
import { spawnDetachedJob } from '../jobs/spawn.js';

vi.mock('../jobs/spawn.js', () => ({ spawnDetachedJob: vi.fn() }));

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

describe('ailoud summarize', () => {
  it('summarises a recording', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize', 'ID001']);
    expect(ctx.lines.join('\n')).toContain('a summary');
  });

  it('puts the transcript, with speaker names, into the prompt', async () => {
    // The reason annotate exists: the model should attribute points to a
    // person, not to "speaker_00".
    const ctx = await contextWithTranscript({ clearLines: true });
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize', 'ID001']);
    const prompt = ctx.summarizerPrompts[0] ?? '';
    expect(prompt).toContain('Privet.');
    expect(prompt).toMatch(/language the transcript is in/);
  });

  it('refuses to summarise the whole library by accident', async () => {
    // Minutes of local inference, or real money on a hosted model. Unlike
    // transcribe, there is deliberately no default selection.
    const ctx = await contextWithTranscript({ clearLines: true });
    await expect(buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize'])).rejects.toThrow(
      UsageError,
    );
    await expect(buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize'])).rejects.toThrow(
      /needs recording ids or --tag/,
    );
  });

  it('refuses ids and --tag together', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await expect(
      buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize', 'ID001', '--tag', 'x']),
    ).rejects.toThrow(/not both/);
  });

  it('says which recording has no transcript rather than summarising nothing', async () => {
    const ctx = await contextWithTranscript({ skipTranscribe: true, clearLines: true });
    await expect(
      buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize', 'ID001']),
    ).rejects.toThrow(/has no transcript yet/);
  });

  it('says so when a tag matches nothing', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await expect(
      buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize', '--tag', 'nothing']),
    ).rejects.toThrow(/No recordings carry/);
  });

  it('summarises a tagged group together, in one request', async () => {
    // "What came out of these conversations" is a different question from
    // three separate answers, which the user can already get by running the
    // command three times.
    const ctx = await contextWithTranscript({ clearLines: true });
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'annotate', 'ID001', '--tag', 'standup']);
    ctx.summarizerPrompts.length = 0;
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize', '--tag', 'standup']);
    expect(ctx.summarizerPrompts).toHaveLength(1);
  });

  it('takes an id prefix like every other command', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize', 'ID0']);
    expect(ctx.lines.join('\n')).toContain('a summary');
  });
});

describe('ailoud summarize --lang', () => {
  it('names the language, not the code, in the prompt', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize', 'ID001', '--lang', 'ru']);
    expect(ctx.summarizerPrompts[0]).toContain('Write in Russian.');
  });

  it('leaves the language to the transcript when not asked', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize', 'ID001']);
    expect(ctx.summarizerPrompts[0]).toContain('the language the transcript is in');
  });
});

describe('ailoud summarize: what it keeps', () => {
  it('stores the summary with what produced it', async () => {
    // The model and language are the point: a summary later reused as context
    // is worth less if nobody can tell what wrote it or in what language.
    const ctx = await contextWithTranscript({ clearLines: true });
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize', 'ID001', '--lang', 'en']);
    const stored = await ctx.store.listSummaries('ID001');
    expect(stored).toHaveLength(1);
    expect(stored[0]!.model).toBe('fake-model');
    expect(stored[0]!.language).toBe('en');
    expect(stored[0]!.recordingIds).toEqual(['ID001']);
  });

  it('does not store anything with --no-save', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize', 'ID001', '--no-save']);
    expect(await ctx.store.listSummaries('ID001')).toEqual([]);
  });

  it('never re-summarises its own summary of a single recording', async () => {
    // A summary of a summary is a game of telephone: each pass is further
    // from what anybody actually said. Asking again about one recording, or
    // asking in another language, has to go back to the transcript.
    const ctx = await contextWithTranscript({ clearLines: true });
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize', 'ID001']);
    ctx.summarizerPrompts.length = 0;
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize', 'ID001', '--lang', 'ru']);
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
        template: 'meeting',
        context: '',
        body: `summary of ${id}`,
        recordingIds: [id],
      });
      await ctx.store.addTags(id, ['group']);
    }
    ctx.summarizerPrompts.length = 0;
    ctx.lines.length = 0;
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize', '--tag', 'group']);
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
      template: 'meeting',
      context: '',
      body: 'stored',
      recordingIds: ['ID001'],
    });
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize', 'ID001', '--fresh']);
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
      template: 'meeting',
      context: '',
      body: 'group summary',
      recordingIds: ['ID001', 'ID002'],
    });
    expect(await ctx.store.latestSummaryOf('ID001')).toBeNull();
  });
});

describe('ailoud summarize: the transcript files', () => {
  it('writes one file per recording, named from its date, into a directory it then removes', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    const written: string[] = [];
    const realWrite = ctx.fs.writeTextFile.bind(ctx.fs);
    ctx.fs.writeTextFile = async (path: string, content: string) => {
      written.push(path);
      return realWrite(path, content);
    };
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize', 'ID001', '--fresh']);
    // Templates are written out too, on first use; only the transcripts are
    // what this test is about.
    const transcripts = written.filter((path) => path.includes('record-'));
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]).toMatch(/record-\d{14}\.txt$/);
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
      buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize', 'ID001']),
    ).rejects.toThrow(/model exploded/);
    expect([...(ctx.fs as MemFs).files.keys()].filter((p) => p.includes('record-'))).toEqual([]);
  });
});

describe('ailoud summarize: progress', () => {
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
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize', 'ID001', '--fresh']);
    const progress = ctx.lines.filter((line) => /\(\d+%\)/.test(line));
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toMatch(/^Combining portions/);
    // Never claims to be finished while a request is still outstanding.
    expect(progress.join('\n')).not.toContain('(100%)');
  });

  it('claims no percentage when there is only one request', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize', 'ID001', '--fresh']);
    expect(ctx.lines.filter((line) => /%\)/.test(line))).toEqual([]);
  });
});

describe('ailoud summarize --job', () => {
  it('is hidden from --help', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    const program = buildProgram(ctx);
    const summarizeCmd = program.commands.find((c) => c.name() === 'summarize')!;
    const jobOption = summarizeCmd.options.find((o) => o.long === '--job');
    expect(jobOption?.hidden).toBe(true);
  });

  it('never appears in rendered --help text either', async () => {
    // The option-object check above pins commander's `hidden` flag, but not
    // that commander actually honours it when rendering. Checked against the
    // pinned commander version in use.
    const ctx = await contextWithTranscript({ clearLines: true });
    const program = buildProgram(ctx);
    const summarizeCmd = program.commands.find((c) => c.name() === 'summarize')!;
    expect(summarizeCmd.helpInformation()).not.toContain('--job');
  });

  it('rejects an id with no matching job', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await expect(
      buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize', 'ID001', '--job', 'nope']),
    ).rejects.toThrow(UsageError);
    await expect(
      buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize', 'ID001', '--job', 'nope']),
    ).rejects.toThrow(/nope/);
  });

  it('reports success into the job state file, without the summary body', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await withRealDataDir(ctx, async () => {
      const job = await createJob(
        { fs: ctx.fs, ids: ctx.ids, clock: ctx.clock, jobsDir: ctx.paths.jobsDir },
        { kind: 'summarize', recordings: 1, declared: null },
      );
      await buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize', 'ID001', '--job', job.id]);
      const state = await getJob(ctx.fs, ctx.paths.jobsDir, job.id);
      expect(state?.state).toBe('done');
      expect(state?.percent).toBe(100);
      expect(state?.result).toMatchObject({ reportId: expect.any(String) });
      expect(JSON.stringify(state?.result)).not.toContain('a summary');
    });
  });

  it('reports a failure into the job state file and still rethrows, exit code unchanged', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await withRealDataDir(ctx, async () => {
      const job = await createJob(
        { fs: ctx.fs, ids: ctx.ids, clock: ctx.clock, jobsDir: ctx.paths.jobsDir },
        { kind: 'summarize', recordings: 1, declared: null },
      );
      await expect(
        buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize', 'NOPE', '--job', job.id]),
      ).rejects.toThrow();
      const state = await getJob(ctx.fs, ctx.paths.jobsDir, job.id);
      expect(state?.state).toBe('failed');
      expect(state?.error).toBeTruthy();
    });
  });

  it('records a failure when the job lock is already held on the way in', async () => {
    // See the identical test in commands.test.ts (transcribe --job) for why:
    // withJobLock itself can throw before body() ever runs, and the
    // try/catch has to wrap the lock call, not just its body, to catch that.
    const ctx = await contextWithTranscript({ clearLines: true });
    await withRealDataDir(ctx, async () => {
      const job = await createJob(
        { fs: ctx.fs, ids: ctx.ids, clock: ctx.clock, jobsDir: ctx.paths.jobsDir },
        { kind: 'summarize', recordings: 1, declared: null },
      );
      await withJobLock(ctx.paths.dataDir, async () => {
        await expect(
          buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize', 'ID001', '--job', job.id]),
        ).rejects.toThrow(FailureError);
      });
      const state = await getJob(ctx.fs, ctx.paths.jobsDir, job.id);
      expect(state?.state).toBe('failed');
      expect(state?.error).toMatch(/already running/);
    });
  });
});

describe('ailoud summarize --detach', () => {
  afterEach(() => {
    vi.mocked(spawnDetachedJob).mockReset();
  });

  it('is not hidden from --help, unlike --job', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    const program = buildProgram(ctx);
    const summarizeCmd = program.commands.find((c) => c.name() === 'summarize')!;
    const detachOption = summarizeCmd.options.find((o) => o.long === '--detach');
    expect(detachOption?.hidden).toBeFalsy();
  });

  it('rejects --detach together with --job before doing anything', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await expect(
      buildProgram(ctx).parseAsync([
        'node',
        'ailoud',
        'summarize',
        'ID001',
        '--detach',
        '--job',
        'X',
      ]),
    ).rejects.toThrow(UsageError);
    expect(spawnDetachedJob).not.toHaveBeenCalled();
  });

  it('validates an unknown --template before creating a job or spawning anything', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await withRealDataDir(ctx, async () => {
      await expect(
        buildProgram(ctx).parseAsync([
          'node',
          'ailoud',
          'summarize',
          'ID001',
          '--template',
          'retrospective',
          '--detach',
        ]),
      ).rejects.toThrow(/unknown --template "retrospective"/);
      expect(spawnDetachedJob).not.toHaveBeenCalled();
      expect(await listJobs(ctx.fs, ctx.paths.jobsDir)).toEqual([]);
    });
  });

  it('validates the id/--tag selection before creating a job or spawning anything', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await withRealDataDir(ctx, async () => {
      await expect(
        buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize', '--detach']),
      ).rejects.toThrow(/needs recording ids or --tag/);
      expect(spawnDetachedJob).not.toHaveBeenCalled();
      expect(await listJobs(ctx.fs, ctx.paths.jobsDir)).toEqual([]);
    });
  });

  it('refuses when another job already holds the lock, without creating a job', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await withRealDataDir(ctx, async () => {
      await withJobLock(ctx.paths.dataDir, async () => {
        await expect(
          buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize', 'ID001', '--detach']),
        ).rejects.toThrow(FailureError);
      });
      expect(spawnDetachedJob).not.toHaveBeenCalled();
      expect(await listJobs(ctx.fs, ctx.paths.jobsDir)).toEqual([]);
    });
  });

  it('creates a running job, spawns the build args without --detach, and returns at once', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await withRealDataDir(ctx, async () => {
      ctx.lines.length = 0;
      await buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize', 'ID001', '--detach']);
      expect(spawnDetachedJob).toHaveBeenCalledTimes(1);
      const [, commandArgs, job] = vi.mocked(spawnDetachedJob).mock.calls[0]!;
      expect(commandArgs).toEqual(['summarize', 'ID001']);
      const state = await getJob(ctx.fs, ctx.paths.jobsDir, job.id);
      expect(state?.state).toBe('running');
      expect(ctx.lines.join('\n')).toContain(job.id);
    });
  });

  it('preserves a --context value that is itself the literal string "--detach"', async () => {
    // The child args used to be built by filtering process.argv for the
    // string '--detach', which stripped every occurrence -- including one
    // that was actually the value of --context, not the flag -- corrupting
    // the child's invocation. Building from the parsed options instead
    // means only the real flag is ever left out.
    const ctx = await contextWithTranscript({ clearLines: true });
    await withRealDataDir(ctx, async () => {
      await buildProgram(ctx).parseAsync([
        'node',
        'ailoud',
        'summarize',
        'ID001',
        '--context',
        '--detach',
        '--detach',
      ]);
      expect(spawnDetachedJob).toHaveBeenCalledTimes(1);
      const [, commandArgs] = vi.mocked(spawnDetachedJob).mock.calls[0]!;
      expect(commandArgs).toEqual(['summarize', 'ID001', '--context', '--detach']);
    });
  });

  it('marks the job failed and rethrows when spawning itself throws', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await withRealDataDir(ctx, async () => {
      vi.mocked(spawnDetachedJob).mockImplementation(() => {
        throw new Error('spawn boom');
      });
      const before = new Set((await listJobs(ctx.fs, ctx.paths.jobsDir)).map((j) => j.id));
      await expect(
        buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize', 'ID001', '--detach']),
      ).rejects.toThrow(/spawn boom/);
      const after = await listJobs(ctx.fs, ctx.paths.jobsDir);
      const created = after.find((job) => !before.has(job.id));
      expect(created?.state).toBe('failed');
      expect(created?.error).toContain('spawn boom');
    });
  });
});

describe('ailoud summarize --max-cpu', () => {
  afterEach(() => {
    vi.mocked(spawnDetachedJob).mockReset();
  });

  it.each(['0', '101', 'abc', '-5', '2.5'])(
    'refuses --max-cpu %s, naming the accepted range',
    async (value) => {
      const ctx = await contextWithTranscript({ clearLines: true });
      await expect(
        buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize', 'ID001', '--max-cpu', value]),
      ).rejects.toThrow(/1.*100/);
    },
  );

  it('accepts a --max-cpu inside the range and forwards the resulting budget to the summarizer', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize', 'ID001', '--max-cpu', '50']);
    // testContext's fixed topology is { logical: 10, performance: 8 }: 50% of the
    // 8 performance cores, rounded, is 4.
    //
    // createSummarizer is called twice per `summarize` run -- once at
    // summarize.ts:216 for the summarizer's name (used in a progress note),
    // once inside runSummary at summarizeRun.ts:113, which is the call that
    // actually does the work -- and both must carry the budget. Asserting the
    // whole array, not just toContainEqual, is what makes this catch a
    // dropped argument at summarizeRun.ts:113 specifically: before this test
    // was tightened, that call site could fall back to createSummarizer's own
    // "no budget" default of 4 threads while the name-only call at
    // summarize.ts:216 still supplied a real budget, and `toContainEqual`
    // against a shared array could not tell the two apart.
    expect(ctx.summarizerBudgets).toEqual([
      expect.objectContaining({ threads: 4, gpu: true }),
      expect.objectContaining({ threads: 4, gpu: true }),
    ]);
  });

  it('does not register --denoise: summarizing reads stored transcripts, not audio', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    const program = buildProgram(ctx);
    const summarizeCmd = program.commands.find((c) => c.name() === 'summarize')!;
    expect(summarizeCmd.options.find((o) => o.long === '--denoise')).toBeUndefined();
  });

  it('does not register --no-gpu: no summariser reads budget.gpu', async () => {
    // --no-gpu was removed from summarize because it provably did nothing:
    // llama's -ngl was deliberately dropped for want of a measurement, and
    // the three hosted providers (claude-cli, anthropic, openai-compatible)
    // have no GPU to disable. It stays on transcribe, where it reaches
    // whisper's -ng.
    const ctx = await contextWithTranscript({ clearLines: true });
    const program = buildProgram(ctx);
    const summarizeCmd = program.commands.find((c) => c.name() === 'summarize')!;
    expect(summarizeCmd.options.find((o) => o.long === '--no-gpu')).toBeUndefined();
    await expect(
      buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize', 'ID001', '--no-gpu']),
    ).rejects.toThrow(/unknown option/);
  });

  it('validates --max-cpu before creating a job or spawning anything, under --detach', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await withRealDataDir(ctx, async () => {
      await expect(
        buildProgram(ctx).parseAsync([
          'node',
          'ailoud',
          'summarize',
          'ID001',
          '--max-cpu',
          '0',
          '--detach',
        ]),
      ).rejects.toThrow(/1.*100/);
      expect(spawnDetachedJob).not.toHaveBeenCalled();
      expect(await listJobs(ctx.fs, ctx.paths.jobsDir)).toEqual([]);
    });
  });

  it('forwards --max-cpu to the detached child, unmodified', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await withRealDataDir(ctx, async () => {
      await buildProgram(ctx).parseAsync([
        'node',
        'ailoud',
        'summarize',
        'ID001',
        '--max-cpu',
        '50',
        '--detach',
      ]);
      expect(spawnDetachedJob).toHaveBeenCalledTimes(1);
      const [, commandArgs] = vi.mocked(spawnDetachedJob).mock.calls[0]!;
      expect(commandArgs).toEqual(['summarize', 'ID001', '--max-cpu', '50']);
    });
  });

  it('forwards nothing to the detached child when nothing was asked for', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await withRealDataDir(ctx, async () => {
      await buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize', 'ID001', '--detach']);
      const [, commandArgs] = vi.mocked(spawnDetachedJob).mock.calls[0]!;
      expect(commandArgs).not.toContain('--max-cpu');
    });
  });
});

describe('ailoud summarize --template / --context', () => {
  it('shapes the headings by template', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await buildProgram(ctx).parseAsync([
      'node',
      'ailoud',
      'summarize',
      'ID001',
      '--template',
      'one-on-one',
    ]);
    expect(ctx.summarizerPrompts[0]).toContain('Concerns raised');
    expect(ctx.summarizerPrompts[0]).toMatch(/one-to-one/i);
  });

  it('passes the caller context through, labelled', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await buildProgram(ctx).parseAsync([
      'node',
      'ailoud',
      'summarize',
      'ID001',
      '--context',
      'Ann is the manager.',
    ]);
    expect(ctx.summarizerPrompts[0]).toContain(
      'Context from the person asking: Ann is the manager.',
    );
  });

  it('rejects an unknown template before reading or spawning anything', async () => {
    // Milliseconds, not after a transcript has been chunked.
    const ctx = await contextWithTranscript({ clearLines: true });
    await expect(
      buildProgram(ctx).parseAsync([
        'node',
        'ailoud',
        'summarize',
        'ID001',
        '--template',
        'retrospective',
      ]),
    ).rejects.toThrow(/unknown --template "retrospective"/);
    expect(ctx.summarizerPrompts).toHaveLength(0);
  });

  it('stores the template and context with the report, so it can be read back', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await buildProgram(ctx).parseAsync([
      'node',
      'ailoud',
      'summarize',
      'ID001',
      '--template',
      'architecture-planning',
      '--context',
      'Deciding the storage engine.',
    ]);
    const stored = (await ctx.store.listSummaries('ID001'))[0]!;
    expect(stored.template).toBe('architecture-planning');
    expect(stored.context).toBe('Deciding the storage engine.');
  });

  it('defaults to the meeting shape', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'summarize', 'ID001']);
    expect(ctx.summarizerPrompts[0]).toContain('Decisions');
    expect((await ctx.store.listSummaries('ID001'))[0]!.template).toBe('meeting');
  });
});
