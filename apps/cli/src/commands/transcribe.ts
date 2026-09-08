import type { Command } from 'commander';
import { Option } from 'commander';
import {
  FailureError,
  summarizeLanguages,
  transcribeRecording,
  UsageError,
  weightedOverall,
} from '@ailoud/core';
import type { Recording } from '@ailoud/core';
import type { CliContext } from '../wiring.js';
import { resolveRecordings } from '../resolveId.js';
import { collectTag, parseTags } from '../tags.js';
import { parseDenoise, parseMaxCpu } from './resourceOptions.js';
import { JobLog } from '../jobs/log.js';
import { JobReporter } from '../jobs/reporter.js';
import { createJob } from '../jobs/store.js';
import { jobBusyMessage, jobLockHolder, withJobLock } from '../jobs/lock.js';
import { loadJob } from '../jobs/loadJob.js';
import { jobStatePath } from '../jobs/state.js';
import { spawnDetachedJob } from '../jobs/spawn.js';

interface TranscribeOptions {
  readonly lang?: string;
  readonly model?: string;
  readonly force?: boolean;
  readonly multilingual?: boolean;
  readonly diarize?: boolean;
  readonly speakers?: string;
  readonly tag?: string[];
  readonly maxCpu?: string;
  readonly gpu?: boolean;
  readonly denoise?: string;
  readonly job?: string;
  readonly detach?: boolean;
}

/**
 * Parses `--lang`, the comma-separated set of languages the caller says the
 * recording holds.
 *
 * Returns an empty list for `auto` and for the flag being absent, which both
 * mean "decide for yourself" -- the caller then treats emptiness as "nothing
 * declared" rather than having to special-case the word.
 *
 * Rejects rather than repairs. A stray comma, a repeated code, or `auto`
 * mixed with a real code all mean the user believes something about this run
 * that is not true, and quietly normalising any of them would hide that.
 */
export function parseLanguages(raw: string | undefined): readonly string[] {
  if (raw === undefined) return [];
  const parts = raw.split(',').map((part) => part.trim());
  if (parts.some((part) => part === '')) {
    throw new UsageError(`--lang has an empty entry, got "${raw}". Use codes like "ru,en".`);
  }
  const codes = parts.map((part) => part.toLowerCase());
  if (codes.length === 1 && codes[0] === 'auto') return [];
  if (codes.includes('auto')) {
    throw new UsageError(
      `--lang cannot mix "auto" with a language, got "${raw}": "auto" means detect everything, ` +
        'so naming a language alongside it says two contradictory things.',
    );
  }
  for (const code of codes) {
    if (!/^[a-z]{2,3}$/.test(code)) {
      throw new UsageError(
        `--lang expects two- or three-letter language codes, got "${code}" in "${raw}".`,
      );
    }
  }
  const duplicate = codes.find((code, index) => codes.indexOf(code) !== index);
  if (duplicate !== undefined) {
    throw new UsageError(`--lang lists "${duplicate}" twice, in "${raw}".`);
  }
  return codes;
}

/**
 * Parses `--speakers`. Commander hands the raw string through untouched, so
 * this is the only place that decides "3.5", "0", "-1", and "abc" are all
 * rejected rather than silently becoming NaN or a nonsensical speaker count.
 */
function parseSpeakerCount(raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new UsageError(`--speakers must be a positive integer, got "${raw}".`);
  }
  return value;
}

interface ResolvedTranscribeRun {
  readonly multilingual: boolean;
  readonly languages: readonly string[];
  /**
   * What the caller literally declared with `--lang`, for the job's
   * `declared` field -- distinct from `languages` above, which is what the
   * pipeline actually acts on.
   *
   * `--lang` absent and `--lang auto` both parse to the same empty
   * `languages` set ("decide for yourself"), but they are not the same
   * declaration: one caller said nothing, the other said "I don't know".
   * Collapsing them would erase the one distinction `declared` exists to
   * keep -- see JobState.declared's own comment ("a later question about
   * why diarization went badly has an answer"). `["auto"]` here is that
   * answer; `[]` means the flag was never given at all.
   */
  readonly declaredLanguages: readonly string[];
  readonly speakers: number | undefined;
  readonly tags: readonly string[];
  readonly recordings: readonly Recording[];
}

/**
 * Validates and resolves everything transcribe needs before any work starts:
 * the language set, the speaker count, the tags, and which recordings are in
 * scope.
 *
 * Shared between the normal run and `--detach`, so a bad `--lang`, a bad
 * `--speakers`, an unparseable tag, or an unresolvable recording id costs a
 * usage error right here, at the prompt -- never an hour later in a job
 * nobody is watching.
 */
async function resolveTranscribeRun(
  context: CliContext,
  ids: readonly string[],
  options: TranscribeOptions,
): Promise<ResolvedTranscribeRun> {
  if (options.force === true && ids.length === 0) {
    throw new UsageError(
      '--force needs explicit recording ids: it would otherwise re-transcribe the whole library.',
    );
  }
  const languages = parseLanguages(options.lang);
  // See ResolvedTranscribeRun.declaredLanguages: parseLanguages collapses
  // an absent --lang and an explicit "--lang auto" to the same empty array,
  // which is right for the pipeline (both mean "decide for yourself") and
  // wrong for the job record (only one of them is a caller saying "unknown"
  // rather than "nothing declared").
  const declaredLanguages =
    options.lang === undefined ? [] : languages.length === 0 ? ['auto'] : languages;
  // Two or more languages IS the statement that the recording switches
  // between them, so requiring --multilingual as well would be asking the
  // user to say the same thing twice.
  const multilingual = options.multilingual === true || languages.length >= 2;
  if (options.speakers !== undefined && options.diarize !== true) {
    // A flag that silently does nothing is worse than one that complains:
    // without --diarize, --speakers has nothing to inform.
    throw new UsageError('--speakers needs --diarize: it has no effect without it.');
  }
  const speakers = options.speakers === undefined ? undefined : parseSpeakerCount(options.speakers);
  // Parsed before any transcription starts: a bad tag should cost a usage
  // error, not an hour of whisper followed by one.
  const tags = parseTags(options.tag ?? []);
  // Given ids, each may be a prefix; resolveRecordings refuses the whole set
  // unless every one picks out exactly one recording. Given none, the
  // default selector still means "everything not yet transcribed".
  const recordings =
    ids.length > 0
      ? await resolveRecordings(context.store, ids)
      : await context.store.listRecordings({ withoutTranscript: true });
  return { multilingual, languages, declaredLanguages, speakers, tags, recordings };
}

/**
 * Serializes the detached child's argv from the already-parsed, already-
 * validated `ids` and `options` -- never from `process.argv`.
 *
 * An earlier version of this filtered `process.argv.slice(2)` for the
 * literal string `'--detach'`. That breaks two ways: it silently drops any
 * OTHER argument that happens to equal `"--detach"` too -- `--tag --detach`
 * loses its tag value, not just the flag, since commander hands option
 * values through untouched and never rejects one that looks like a flag
 * name; and it trusts `process.argv` to still be exactly `[node, script,
 * ...args]`, which is true for `node dist/bin/ailoud.js ...` but is not a
 * promise any wrapper has to keep -- "pnpm ailoud ..." is how this project
 * runs the CLI in development. Rebuilding from the typed values commander
 * already parsed sidesteps both: nothing here ever inspects raw argv.
 */
function transcribeChildArgs(ids: readonly string[], options: TranscribeOptions): string[] {
  const args: string[] = ['transcribe', ...ids];
  if (options.lang !== undefined) args.push('--lang', options.lang);
  if (options.model !== undefined) args.push('--model', options.model);
  if (options.force === true) args.push('--force');
  if (options.multilingual === true) args.push('--multilingual');
  if (options.diarize === true) args.push('--diarize');
  if (options.speakers !== undefined) args.push('--speakers', options.speakers);
  for (const tag of options.tag ?? []) args.push('--tag', tag);
  if (options.maxCpu !== undefined) args.push('--max-cpu', options.maxCpu);
  if (options.gpu === false) args.push('--no-gpu');
  if (options.denoise !== undefined) args.push('--denoise', options.denoise);
  return args;
}

export function registerTranscribe(program: Command, context: CliContext): void {
  program
    .command('transcribe')
    .argument(
      '[ids...]',
      'recording ids, or enough of each start to be unambiguous; defaults to everything not yet transcribed',
    )
    .option(
      '--lang <codes>',
      'spoken language, or several comma-separated ("ru,en"), or "auto" to detect. Naming two ' +
        'or more turns on multilingual mode and confines detection to them',
    )
    .option('--model <name>', 'override the configured model')
    .option('--force', 're-transcribe recordings that already have a transcript')
    .option(
      '--multilingual',
      'segment the recording by speech and language, and transcribe each language run separately',
    )
    .option('--diarize', 'attribute segments to speakers by running speaker diarization')
    .option('--speakers <n>', 'known number of speakers, to help the diarizer')
    .option(
      '--max-cpu <percent>',
      'share of this machine to use, 1 to 100 (default: the configured 90)',
    )
    .option('--no-gpu', 'do not use the GPU, even where a binary supports it')
    .option('--denoise <mode>', 'auto, on or off (default: the configured off)')
    .option('--tag <tag>', 'group these recordings under a tag; repeatable', collectTag)
    // Hidden, and not a feature: this is how the detached child started by
    // `--detach` and by the MCP server is told which job it is. A user has
    // no reason to pass it, and `--help` listing it would invite exactly the
    // hand-made half-registered job this avoids.
    .addOption(
      new Option(
        '--job <id>',
        'report into an existing job state file instead of the terminal',
      ).hideHelp(),
    )
    .option('--detach', 'start the work in the background and print its job id')
    .description('Turn recordings into transcripts')
    .action(async (ids: string[], options: TranscribeOptions) => {
      // The two ends of one mechanism: --job is how a detached child reports
      // in, --detach is how one gets started. Naming both says two
      // contradictory things about who is driving this run.
      if (options.detach === true && options.job !== undefined) {
        throw new UsageError('--detach cannot be combined with --job.');
      }

      // Parsed above the --detach branch, before a job file exists or
      // anything is spawned, so a bad --max-cpu or --denoise costs nothing --
      // the detached path validates here too, even though the budget and
      // denoise mode computed below are only used by the run that happens in
      // this process, never by the detached child (which parses its own argv
      // and computes its own).
      const budget = await context.resources({
        ...(options.maxCpu === undefined ? {} : { maxCpuPercent: parseMaxCpu(options.maxCpu) }),
        ...(options.gpu === false ? { gpu: false } : {}),
      });
      const denoise =
        options.denoise === undefined
          ? context.config.audio.denoise
          : parseDenoise(options.denoise);

      if (options.detach === true) {
        // Every validation the normal run would do, run here, before the job
        // file exists or anything is spawned -- see resolveTranscribeRun's
        // own comment.
        const resolved = await resolveTranscribeRun(context, ids, options);
        if (resolved.recordings.length === 0) {
          // Only reachable via the default selector: with explicit ids, an
          // empty result means every id was missing, and resolveRecordings
          // (inside resolveTranscribeRun) already threw for that. Refused
          // here, before the lock check or createJob -- the same point
          // summarize refuses an empty selection -- because handing back a
          // job id for "there was never anything to do" is a confusing
          // artifact, and taking the job lock for it is pointless.
          throw new UsageError(
            '--detach has nothing to transcribe: every recording already has a transcript. ' +
              'Pass ids explicitly, or --force, to redo one.',
          );
        }
        const holder = await jobLockHolder(context.paths.dataDir);
        if (holder !== null) {
          throw new FailureError(jobBusyMessage(holder));
        }
        const job = await createJob(
          {
            fs: context.fs,
            ids: context.ids,
            clock: context.clock,
            jobsDir: context.paths.jobsDir,
          },
          {
            kind: 'transcribe',
            recordings: resolved.recordings.length,
            declared: {
              speakers: resolved.speakers ?? 'unknown',
              languages: resolved.declaredLanguages,
            },
          },
        );
        try {
          await spawnDetachedJob(
            { fs: context.fs, jobsDir: context.paths.jobsDir },
            transcribeChildArgs(ids, options),
            job,
          );
        } catch (error) {
          // The id below must always resolve: if the child never started,
          // the job file must say so rather than "running" forever.
          const reporter = new JobReporter({
            fs: context.fs,
            jobsDir: context.paths.jobsDir,
            initial: job,
            log: new JobLog(job.log),
          });
          await reporter.fail(error instanceof Error ? error.message : String(error));
          throw error;
        }
        context.ui.success(
          `started job ${job.id} -- progress in ${jobStatePath(context.paths.jobsDir, job.id)}`,
        );
        return;
      }

      const job = await loadJob(context, options.job);

      const body = async (): Promise<unknown> =>
        context.ui.frame('Transcribing', async () => {
          const { multilingual, languages, speakers, tags, recordings } =
            await resolveTranscribeRun(context, ids, options);

          if (recordings.length === 0) {
            // Only reachable via the default selector: with explicit ids, an
            // empty result means every id was missing, and that already threw
            // above.
            context.ui.nothingToTranscribe();
            return { transcribed: [] };
          }

          const stt = context.createStt(budget);
          const segmenter = multilingual ? context.createSegmenter(budget) : undefined;
          const diarizer = options.diarize === true ? context.createDiarizer(budget) : undefined;
          const transcribed: Array<{
            recordingId: string;
            transcriptId: string;
            language: string;
            segments: number;
          }> = [];
          // Collected here, not just handed to context.ui.warn: there is no
          // terminal to read under a detached job (stdio is 'ignore'), and a
          // diarizer that failed silently would leave a poller of job_status
          // believing the transcript has speakers when it does not. Folded
          // into the returned result below so it reaches reporter.finish(),
          // and from there whoever polls the job.
          const warnings: string[] = [];
          // Reused whenever a stage's fraction cannot be measured (the
          // diarizer pass), so that stage only changes the text shown to the
          // user and never walks the number backwards. The same rule
          // weightedOverall and JobReporter.report already follow.
          let lastFraction = 0;
          for (const [index, recording] of recordings.entries()) {
            if (options.force !== true) {
              const existing = await context.store.latestTranscript(recording.id);
              if (existing !== null) {
                context.ui.skipped(recording);
                continue;
              }
            }
            const transcript = await context.ui.transcribing(recording, (report) =>
              transcribeRecording(
                {
                  fs: context.fs,
                  store: context.store,
                  audio: context.audio,
                  stt,
                  clock: context.clock,
                  ids: context.ids,
                  mediaRoot: context.paths.mediaRoot,
                  onWarning: (message) => {
                    context.ui.warn(message);
                    job?.log.append(`warning: ${message}`);
                    warnings.push(message);
                  },
                  // The job log only, never ui.warn -- which onWarning above
                  // already reaches. A foreground run has no job log and so
                  // correctly prints nothing here.
                  onNotice: (message) => {
                    job?.log.append(message);
                  },
                  onProgress: (event) => {
                    // Weighted by duration across the batch, so finishing four
                    // short recordings out of five does not claim 80%.
                    const overall =
                      event.fraction === undefined
                        ? lastFraction
                        : weightedOverall(
                            recordings.map((r) => r.durationMs),
                            index,
                            event.fraction,
                          );
                    lastFraction = overall;
                    report(event.stage, overall);
                    job?.reporter.report({ stage: event.stage, fraction: overall });
                  },
                  ...(segmenter === undefined ? {} : { segmenter }),
                  ...(diarizer === undefined ? {} : { diarizer }),
                },
                recording,
                {
                  // One declared language means force it for the whole file, the
                  // single-pass case. Two or more means multilingual, where the
                  // set constrains detection instead of forcing an answer. The
                  // single-language-plus---multilingual case lands in the second
                  // branch with a one-member set: degenerate, but coherent, and
                  // not worth refusing.
                  ...(!multilingual && languages.length === 1 ? { language: languages[0] } : {}),
                  ...(options.model === undefined ? {} : { model: options.model }),
                  ...(multilingual ? { multilingual: true, declaredLanguages: languages } : {}),
                  ...(options.diarize === true ? { diarize: true } : {}),
                  ...(speakers === undefined ? {} : { speakers }),
                  denoise,
                },
              ),
            );
            job?.reporter.advance(index + 1);
            if (tags.length > 0) await context.store.addTags(recording.id, tags);
            const segments = await context.store.listSegments(transcript.id);
            context.ui.transcribed(
              recording,
              transcript,
              segments.length,
              summarizeLanguages(segments),
            );
            transcribed.push({
              recordingId: recording.id,
              transcriptId: transcript.id,
              language: transcript.language,
              segments: segments.length,
            });
          }
          return { transcribed, ...(warnings.length === 0 ? {} : { warnings }) };
        });

      if (job === undefined) {
        await body();
        return;
      }
      // The try/catch wraps withJobLock itself, not just its body. Taking
      // the lock can throw before body() ever runs -- losing the advisory
      // race against another process, or any other failure on the way in --
      // and a catch placed inside withJobLock's callback never sees that:
      // the state file would stay 'running' forever with nothing to explain
      // why, while withLiveness eventually reports it failed pointing at a
      // log that was never created. See the spec, section 2: "the child then
      // fails cleanly against the real lock with the same message the parent
      // would have given" -- which only happens if something records it.
      try {
        await withJobLock(context.paths.dataDir, async () => {
          const result = await body();
          await job.reporter.finish(result);
        });
      } catch (error) {
        await job.reporter.fail(error instanceof Error ? error.message : String(error));
        throw error;
      }
    });
}
