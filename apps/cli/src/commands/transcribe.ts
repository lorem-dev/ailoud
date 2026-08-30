import type { Command } from 'commander';
import { FailureError, summarizeLanguages, transcribeRecording, UsageError } from '@laud/core';
import type { CliContext } from '../wiring.js';

interface TranscribeOptions {
  readonly sttLang: string;
  readonly model?: string;
  readonly force?: boolean;
  readonly multilingual?: boolean;
  readonly diarize?: boolean;
  readonly speakers?: string;
}

/**
 * Parses `--speakers`. Commander hands the raw string through untouched, so
 * this is the only place that decides "3.5", "0", "-1", and "abc" are all
 * rejected rather than silently becoming NaN or a nonsensical speaker count.
 */
function parseSpeakerCount(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new UsageError(`--speakers must be a positive integer, got "${raw}".`);
  }
  return value;
}

export function registerTranscribe(program: Command, context: CliContext): void {
  program
    .command('transcribe')
    .argument('[ids...]', 'recording ids; defaults to everything not yet transcribed')
    .option('--stt-lang <code>', 'spoken language, or "auto" to detect', 'auto')
    .option('--model <name>', 'override the configured model')
    .option('--force', 're-transcribe recordings that already have a transcript')
    .option(
      '--multilingual',
      'segment the recording by speech and language, and transcribe each language run separately',
    )
    .option('--diarize', 'attribute segments to speakers by running speaker diarization')
    .option('--speakers <n>', 'known number of speakers, to help the diarizer')
    .description('Turn recordings into transcripts')
    .action(async (ids: string[], options: TranscribeOptions) => {
      await context.ui.frame('Transcribing', async () => {
        if (options.force === true && ids.length === 0) {
          throw new UsageError(
            '--force needs explicit recording ids: it would otherwise re-transcribe the whole library.',
          );
        }
        if (options.multilingual === true && options.sttLang !== 'auto') {
          throw new UsageError(
            '--stt-lang and --multilingual contradict each other: --stt-lang forces one ' +
              'language for the whole recording, while --multilingual detects one per ' +
              'stretch. Drop one of the two.',
          );
        }
        if (options.speakers !== undefined && options.diarize !== true) {
          // A flag that silently does nothing is worse than one that
          // complains: without --diarize, --speakers has nothing to inform.
          throw new UsageError('--speakers needs --diarize: it has no effect without it.');
        }
        const speakers =
          options.speakers === undefined ? undefined : parseSpeakerCount(options.speakers);
        const recordings =
          ids.length > 0
            ? await context.store.listRecordings({ ids })
            : await context.store.listRecordings({ withoutTranscript: true });

        if (ids.length > 0) {
          const found = new Set(recordings.map((recording) => recording.id));
          const missing = ids.filter((id) => !found.has(id));
          if (missing.length > 0) {
            throw new FailureError(
              missing.length === 1
                ? `No recording with id ${missing[0]}.`
                : `No recordings with ids ${missing.join(', ')}.`,
            );
          }
        }

        if (recordings.length === 0) {
          // Only reachable via the default selector: with explicit ids, an
          // empty result means every id was missing, and that already threw
          // above.
          context.ui.nothingToTranscribe();
          return;
        }

        const stt = context.createStt();
        const segmenter = options.multilingual === true ? context.createSegmenter() : undefined;
        const diarizer = options.diarize === true ? context.createDiarizer() : undefined;
        for (const recording of recordings) {
          if (options.force !== true) {
            const existing = await context.store.latestTranscript(recording.id);
            if (existing !== null) {
              context.ui.skipped(recording);
              continue;
            }
          }
          const transcript = await context.ui.transcribing(recording, () =>
            transcribeRecording(
              {
                fs: context.fs,
                store: context.store,
                audio: context.audio,
                stt,
                clock: context.clock,
                ids: context.ids,
                mediaRoot: context.paths.mediaRoot,
                onWarning: (message) => context.ui.warn(message),
                ...(segmenter === undefined ? {} : { segmenter }),
                ...(diarizer === undefined ? {} : { diarizer }),
              },
              recording,
              {
                ...(options.sttLang === 'auto' ? {} : { language: options.sttLang }),
                ...(options.model === undefined ? {} : { model: options.model }),
                ...(options.multilingual === true ? { multilingual: true } : {}),
                ...(options.diarize === true ? { diarize: true } : {}),
                ...(speakers === undefined ? {} : { speakers }),
              },
            ),
          );
          const segments = await context.store.listSegments(transcript.id);
          context.ui.transcribed(
            recording,
            transcript,
            segments.length,
            summarizeLanguages(segments),
          );
        }
      });
    });
}
