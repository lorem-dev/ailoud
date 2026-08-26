import type { Command } from 'commander';
import { FailureError, toPlainText, toSrt, toVtt, UsageError } from '@laud/core';
import type { Transcript } from '@laud/core';
import type { CliContext } from '../wiring.js';

const FORMATS = ['text', 'json', 'srt', 'vtt'] as const;
type Format = (typeof FORMATS)[number];

export function registerShow(program: Command, context: CliContext): void {
  program
    .command('show')
    .argument('<id>', 'recording id')
    .option('--format <format>', `one of ${FORMATS.join(', ')}`, 'text')
    .option('--transcript <id>', 'a specific transcript instead of the newest')
    .description('Print a transcript')
    .action(async (id: string, options: { format: string; transcript?: string }) => {
      if (!FORMATS.includes(options.format as Format)) {
        throw new UsageError(
          `Unknown format "${options.format}". Use one of: ${FORMATS.join(', ')}.`,
        );
      }
      const recording = await context.store.getRecording(id);
      if (recording === null) throw new FailureError(`No recording with id ${id}.`);

      let transcript: Transcript | null;
      if (options.transcript === undefined) {
        transcript = await context.store.latestTranscript(id);
      } else {
        const candidate = await context.store.getTranscript(options.transcript);
        if (candidate === null || candidate.recordingId !== id) {
          throw new FailureError(`${options.transcript} is not a transcript of recording ${id}.`);
        }
        transcript = candidate;
      }
      if (transcript === null) {
        throw new FailureError(`${id} has no transcript yet. Run "laud transcribe ${id}".`);
      }
      const segments = await context.store.listSegments(transcript.id);

      switch (options.format as Format) {
        case 'text':
          context.out(toPlainText(segments));
          return;
        case 'srt':
          context.out(toSrt(segments));
          return;
        case 'vtt':
          context.out(toVtt(segments));
          return;
        case 'json':
          context.out(JSON.stringify({ recording, transcript, segments }, null, 2));
          return;
      }
    });
}
