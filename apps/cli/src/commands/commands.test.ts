import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { FailureError, UsageError } from '@ailoud/core';
import type { Recording } from '@ailoud/core';
import { FakeStt } from '@ailoud/core/testing';
import { buildProgram } from '../program.js';
import { context, withRealDataDir } from './testContext.js';
import { parseLanguages } from './transcribe.js';
import { group } from './groups.js';
import { PlainUi } from '../ui/plain.js';
import { createJob, getJob } from '../jobs/store.js';

describe('group', () => {
  it('gives a noun without a plural exactly one name', () => {
    const program = new Command();
    group(program, 'self', undefined, 'manage this installation');
    const self = program.commands.find((c) => c.name() === 'self')!;
    expect(self.aliases()).toEqual([]);
  });

  it('still aliases a noun that has a plural', () => {
    const program = new Command();
    group(program, 'report', 'reports', 'saved reports');
    expect(program.commands.find((c) => c.name() === 'report')!.aliases()).toEqual(['reports']);
  });
});

describe('ailoud import', () => {
  it('prints the id of an imported recording', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'import', '/in/a.mp3']);
    expect(ctx.lines).toEqual(['ID001  imported  /in/a.mp3']);
  });

  it('says so when the file is already in the library', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'import', '/in/a.mp3']);
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'import', '/in/a.mp3']);
    expect(ctx.lines[1]).toBe('ID001  already present  /in/a.mp3');
  });
});

describe('ailoud transcribe', () => {
  it('transcribes every recording without a transcript by default', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'import', '/in/a.mp3']);
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'transcribe']);
    expect(ctx.lines[1]).toBe('ID001  ru  1 segment');
  });

  it('reports that there is nothing to do', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'transcribe']);
    expect(ctx.lines).toEqual(['Nothing to transcribe.']);
  });

  it('refuses --force without a selector', async () => {
    const ctx = context();
    await expect(
      buildProgram(ctx).parseAsync(['node', 'ailoud', 'transcribe', '--force']),
    ).rejects.toThrow(/--force/);
  });

  it('skips a recording that already has a transcript by default', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'import', '/in/a.mp3']);
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'transcribe']);
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'transcribe', 'ID001']);
    expect(ctx.lines[2]).toBe('ID001  already transcribed (use --force)');
  });

  it('--force re-transcribes a recording that already has a transcript', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'import', '/in/a.mp3']);
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'transcribe']);
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'transcribe', 'ID001', '--force']);
    expect(ctx.lines[2]).toBe('ID001  ru  1 segment');
  });

  it('passes --model through to the transcription provider', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'import', '/in/a.mp3']);
    await buildProgram(ctx).parseAsync([
      'node',
      'ailoud',
      'transcribe',
      '--model',
      '/models/big.bin',
    ]);
    expect(ctx.sttInstances).toHaveLength(1);
    expect(ctx.sttInstances[0]!.calls[0]).toEqual(
      expect.objectContaining({ model: '/models/big.bin' }),
    );
  });

  it('passes a single --lang through as the language hint', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'import', '/in/a.mp3']);
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'transcribe', '--lang', 'ru']);
    expect(ctx.lines[1]).toBe('ID001  ru  1 segment');
  });

  it('allows a single --lang together with --multilingual', async () => {
    // This used to be refused as a contradiction. It no longer is: with the
    // flag now carrying a SET, one member is simply a set of one -- every run
    // is that language. Degenerate, but it says something coherent, and
    // refusing it would be refusing the user's own words.
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'import', '/in/a.mp3']);
    // The default fake provider cannot detect a language, so the multilingual
    // path refuses on THAT, which is the proof it was taken.
    await expect(
      buildProgram(ctx).parseAsync([
        'node',
        'ailoud',
        'transcribe',
        '--lang',
        'ru',
        '--multilingual',
      ]),
    ).rejects.toThrow(/cannot detect a language/);
  });

  it('turns multilingual on by itself when --lang names two languages', async () => {
    // Naming two languages IS the statement that the recording switches
    // between them; making the user also pass --multilingual would be asking
    // them to say it twice.
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'import', '/in/a.mp3']);
    await expect(
      buildProgram(ctx).parseAsync(['node', 'ailoud', 'transcribe', '--lang', 'ru,en']),
    ).rejects.toThrow(/cannot detect a language/);
  });

  it('--multilingual reaches the pipeline instead of the single-pass path', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'import', '/in/a.mp3']);
    // The default fake provider does not support language detection, so
    // the multilingual pipeline (packages/core/src/pipelines/transcribe.ts)
    // refuses with its own, distinct error as soon as it checks
    // capabilities -- proof that --multilingual reached transcribeRecording
    // and took the multilingual branch, not the single-pass one.
    await expect(
      buildProgram(ctx).parseAsync(['node', 'ailoud', 'transcribe', '--multilingual']),
    ).rejects.toThrow(/cannot detect a language/);
  });

  it('without --multilingual, transcribe takes the single-pass path', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'import', '/in/a.mp3']);
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'transcribe']);
    expect(ctx.segmenterInstances).toHaveLength(0);
    expect(ctx.lines[1]).toBe('ID001  ru  1 segment');
  });

  it('fails on a mix of known and unknown ids without transcribing the known one', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'import', '/in/a.mp3']);
    await expect(
      buildProgram(ctx).parseAsync(['node', 'ailoud', 'transcribe', 'ID001', 'ID999']),
    ).rejects.toThrow(FailureError);
    await expect(
      buildProgram(ctx).parseAsync(['node', 'ailoud', 'transcribe', 'ID001', 'ID999']),
    ).rejects.toThrow(/ID999/);
    // Only the import line: transcription never ran for ID001 either.
    expect(ctx.lines).toEqual(['ID001  imported  /in/a.mp3']);
  });

  it('fails when every requested id is unknown, transcribing nothing', async () => {
    const ctx = context();
    await expect(
      buildProgram(ctx).parseAsync(['node', 'ailoud', 'transcribe', 'ID999']),
    ).rejects.toThrow(FailureError);
    await expect(
      buildProgram(ctx).parseAsync(['node', 'ailoud', 'transcribe', 'ID999']),
    ).rejects.toThrow(/ID999/);
    expect(ctx.lines).toEqual([]);
  });
});

describe('ailoud transcribe --diarize', () => {
  it('does not build a diarizer without --diarize', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'import', '/in/a.mp3']);
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'transcribe']);
    expect(ctx.diarizerInstances).toHaveLength(0);
  });

  it('--diarize reaches the pipeline and attributes the segment to a speaker', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'import', '/in/a.mp3']);
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'transcribe', '--diarize']);
    expect(ctx.diarizerInstances).toHaveLength(1);
    const recordings = await ctx.store.listRecordings({});
    const transcript = await ctx.store.latestTranscript(recordings[0]!.id);
    const segments = await ctx.store.listSegments(transcript!.id);
    expect(segments.map((s) => s.speaker)).toEqual(['speaker_00']);
  });

  it('forwards --speakers to the diarizer', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'import', '/in/a.mp3']);
    await buildProgram(ctx).parseAsync([
      'node',
      'ailoud',
      'transcribe',
      '--diarize',
      '--speakers',
      '2',
    ]);
    expect(ctx.diarizerInstances).toHaveLength(1);
    expect(ctx.diarizerInstances[0]!.calls[0]).toEqual(expect.objectContaining({ speakers: 2 }));
  });

  it('refuses --speakers without --diarize', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'import', '/in/a.mp3']);
    await expect(
      buildProgram(ctx).parseAsync(['node', 'ailoud', 'transcribe', '--speakers', '2']),
    ).rejects.toThrow(/--speakers needs --diarize/);
  });

  it.each(['0', '-1', 'abc', '1.5', '1e21'])(
    'rejects --speakers %s as not a positive integer',
    async (value) => {
      const ctx = context();
      await buildProgram(ctx).parseAsync(['node', 'ailoud', 'import', '/in/a.mp3']);
      await expect(
        buildProgram(ctx).parseAsync([
          'node',
          'ailoud',
          'transcribe',
          '--diarize',
          '--speakers',
          value,
        ]),
      ).rejects.toThrow(/--speakers must be a positive integer/);
    },
  );
});

/** Captures every `(stage, fraction)` pair `transcribing` reports, in order. */
class SpyUi extends PlainUi {
  public readonly reports: Array<{ readonly stage: string; readonly fraction: number }> = [];

  public override async transcribing<T>(
    _recording: Recording,
    task: (report: (stage: string, fraction: number) => void) => Promise<T>,
  ): Promise<T> {
    return task((stage, fraction) => {
      this.reports.push({ stage, fraction });
    });
  }
}

describe('ailoud transcribe: an unmeasurable stage never lowers the percentage', () => {
  it('reuses the last fraction when the diarizer reports its stage with none of its own', async () => {
    const ctx = context();
    const spy = new SpyUi((line) => ctx.lines.push(line));
    // `ui` is declared readonly on CliContext; Object.assign does not go
    // through that check, and this test's entire job is to swap it out for
    // one that records what transcribing() reports.
    Object.assign(ctx, { ui: spy });
    // Drives transcribe()'s onProgress up near the end of the transcribing
    // stage before diarizing (which reports no fraction of its own) starts.
    ctx.createStt = () => {
      const stt = new FakeStt(
        {
          language: 'ru',
          model: 'base.bin',
          segments: [{ startMs: 0, endMs: 1500, text: 'Privet.' }],
        },
        undefined,
        [],
        [0.5, 1],
      );
      ctx.sttInstances.push(stt);
      return stt;
    };
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'import', '/in/a.mp3']);
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'transcribe', '--diarize']);

    const fractions = spy.reports.map((r) => r.fraction);
    for (let i = 1; i < fractions.length; i += 1) {
      expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]!);
    }
    // The diarizer's first event carries no fraction of its own (see
    // transcribeRecording's "No fraction" comment). Reused, not treated as
    // 0, so the number the UI was told does not walk backwards.
    const noFractionStage = spy.reports.findIndex((r) => r.stage === 'diarizing');
    expect(noFractionStage).toBeGreaterThan(0);
    expect(spy.reports[noFractionStage]!.fraction).toBe(spy.reports[noFractionStage - 1]!.fraction);
  });
});

describe('ailoud transcribe --job', () => {
  it('is hidden from --help', () => {
    const ctx = context();
    const program = buildProgram(ctx);
    const transcribeCmd = program.commands.find((c) => c.name() === 'transcribe')!;
    const jobOption = transcribeCmd.options.find((o) => o.long === '--job');
    expect(jobOption?.hidden).toBe(true);
  });

  it('rejects an id with no matching job', async () => {
    const ctx = context();
    await expect(
      buildProgram(ctx).parseAsync(['node', 'ailoud', 'transcribe', '--job', 'nope']),
    ).rejects.toThrow(UsageError);
    await expect(
      buildProgram(ctx).parseAsync(['node', 'ailoud', 'transcribe', '--job', 'nope']),
    ).rejects.toThrow(/nope/);
  });

  it('reports success into the job state file', async () => {
    const ctx = context();
    await withRealDataDir(ctx, async () => {
      await buildProgram(ctx).parseAsync(['node', 'ailoud', 'import', '/in/a.mp3']);
      const job = await createJob(
        { fs: ctx.fs, ids: ctx.ids, clock: ctx.clock, jobsDir: ctx.paths.jobsDir },
        { kind: 'transcribe', recordings: 1, declared: null },
      );
      await buildProgram(ctx).parseAsync(['node', 'ailoud', 'transcribe', '--job', job.id]);
      const state = await getJob(ctx.fs, ctx.paths.jobsDir, job.id);
      expect(state?.state).toBe('done');
      expect(state?.percent).toBe(100);
      expect(state?.result).toEqual({ transcribed: ['ID001'] });
    });
  });

  it('reports a failure into the job state file and still rethrows, exit code unchanged', async () => {
    const ctx = context();
    await withRealDataDir(ctx, async () => {
      const job = await createJob(
        { fs: ctx.fs, ids: ctx.ids, clock: ctx.clock, jobsDir: ctx.paths.jobsDir },
        { kind: 'transcribe', recordings: 1, declared: null },
      );
      await expect(
        buildProgram(ctx).parseAsync(['node', 'ailoud', 'transcribe', 'ID999', '--job', job.id]),
      ).rejects.toThrow(FailureError);
      const state = await getJob(ctx.fs, ctx.paths.jobsDir, job.id);
      expect(state?.state).toBe('failed');
      expect(state?.error).toContain('ID999');
    });
  });
});

describe('parseLanguages', () => {
  it('treats an absent flag and "auto" alike, as nothing declared', () => {
    expect(parseLanguages(undefined)).toEqual([]);
    expect(parseLanguages('auto')).toEqual([]);
  });

  it('accepts one code, and several', () => {
    expect(parseLanguages('ru')).toEqual(['ru']);
    expect(parseLanguages('ru,en')).toEqual(['ru', 'en']);
  });

  it('tolerates surrounding whitespace and normalises case', () => {
    expect(parseLanguages(' RU , en ')).toEqual(['ru', 'en']);
  });

  it('accepts three-letter codes', () => {
    expect(parseLanguages('rus,eng')).toEqual(['rus', 'eng']);
  });

  it('rejects an empty entry rather than quietly dropping it', () => {
    // A stray comma means the user believes something about this run that is
    // not true; repairing it silently would hide that.
    expect(() => parseLanguages('ru,,en')).toThrow(/empty entry/);
    expect(() => parseLanguages('ru,')).toThrow(/empty entry/);
  });

  it('rejects "auto" mixed with a real language', () => {
    expect(() => parseLanguages('auto,ru')).toThrow(/cannot mix/);
  });

  it('rejects a duplicate', () => {
    expect(() => parseLanguages('ru,en,ru')).toThrow(/"ru" twice/);
  });

  it('rejects something that is not a language code', () => {
    expect(() => parseLanguages('russian')).toThrow(/two- or three-letter/);
    expect(() => parseLanguages('r')).toThrow(/two- or three-letter/);
    expect(() => parseLanguages('ru,7')).toThrow(/two- or three-letter/);
  });
});
