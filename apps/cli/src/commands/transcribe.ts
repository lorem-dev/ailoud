import type { Command } from 'commander';
import { summarizeLanguages, transcribeRecording, UsageError } from '@laud/core';
import type { CliContext } from '../wiring.js';
import { resolveRecordings } from '../resolveId.js';

interface TranscribeOptions {
  readonly lang?: string;
  readonly model?: string;
  readonly force?: boolean;
  readonly multilingual?: boolean;
  readonly diarize?: boolean;
  readonly speakers?: string;
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
    .description('Turn recordings into transcripts')
    .action(async (ids: string[], options: TranscribeOptions) => {
      await context.ui.frame('Transcribing', async () => {
        if (options.force === true && ids.length === 0) {
          throw new UsageError(
            '--force needs explicit recording ids: it would otherwise re-transcribe the whole library.',
          );
        }
        const languages = parseLanguages(options.lang);
        // Two or more languages IS the statement that the recording switches
        // between them, so requiring --multilingual as well would be asking
        // the user to say the same thing twice.
        const multilingual = options.multilingual === true || languages.length >= 2;
        if (options.speakers !== undefined && options.diarize !== true) {
          // A flag that silently does nothing is worse than one that
          // complains: without --diarize, --speakers has nothing to inform.
          throw new UsageError('--speakers needs --diarize: it has no effect without it.');
        }
        const speakers =
          options.speakers === undefined ? undefined : parseSpeakerCount(options.speakers);
        // Given ids, each may be a prefix; resolveRecordings refuses the whole
        // set unless every one picks out exactly one recording. Given none,
        // the default selector still means "everything not yet transcribed".
        const recordings =
          ids.length > 0
            ? await resolveRecordings(context.store, ids)
            : await context.store.listRecordings({ withoutTranscript: true });

        if (recordings.length === 0) {
          // Only reachable via the default selector: with explicit ids, an
          // empty result means every id was missing, and that already threw
          // above.
          context.ui.nothingToTranscribe();
          return;
        }

        const stt = context.createStt();
        const segmenter = multilingual ? context.createSegmenter() : undefined;
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
