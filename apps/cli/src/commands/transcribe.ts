import type { Command } from 'commander';
import { FailureError, transcribeRecording, UsageError } from '@laud/core';
import type { CliContext } from '../wiring.js';

interface TranscribeOptions {
  readonly sttLang: string;
  readonly model?: string;
  readonly force?: boolean;
}

export function registerTranscribe(program: Command, context: CliContext): void {
  program
    .command('transcribe')
    .argument('[ids...]', 'recording ids; defaults to everything not yet transcribed')
    .option('--stt-lang <code>', 'spoken language, or "auto" to detect', 'auto')
    .option('--model <name>', 'override the configured model')
    .option('--force', 're-transcribe recordings that already have a transcript')
    .description('Turn recordings into transcripts')
    .action(async (ids: string[], options: TranscribeOptions) => {
      if (options.force === true && ids.length === 0) {
        throw new UsageError(
          '--force needs explicit recording ids: it would otherwise re-transcribe the whole library.',
        );
      }
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
            },
            recording,
            {
              ...(options.sttLang === 'auto' ? {} : { language: options.sttLang }),
              ...(options.model === undefined ? {} : { model: options.model }),
            },
          ),
        );
        const count = (await context.store.listSegments(transcript.id)).length;
        context.ui.transcribed(recording, transcript, count);
      }
    });
}
