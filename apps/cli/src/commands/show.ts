import type { Command } from 'commander';
import { FailureError, toPlainText, toSrt, toVtt, UsageError } from '@laud/core';
import type { Transcript } from '@laud/core';
import type { CliContext } from '../wiring.js';
import { resolveRecording } from '../resolveId.js';

const FORMATS = ['text', 'json', 'srt', 'vtt'] as const;
type Format = (typeof FORMATS)[number];

export function registerShow(program: Command, context: CliContext): void {
  program
    .command('show')
    .argument('<id>', 'recording id, or enough of its start to be unambiguous')
    .option('--format <format>', `one of ${FORMATS.join(', ')}`, 'text')
    .option('--transcript <id>', 'a specific transcript instead of the newest')
    .description('Print a transcript')
    .action(async (id: string, options: { format: string; transcript?: string }) => {
      // The transcript goes through ui.content(), not straight to stdout:
      // that puts it inside the frame for someone reading a terminal, while
      // a redirect or a pipe -- which selects PlainUi -- still receives the
      // exact bytes. See Ui.content.
      await context.ui.frame('Transcript', async () => {
        if (!FORMATS.includes(options.format as Format)) {
          throw new UsageError(
            `Unknown format "${options.format}". Use one of: ${FORMATS.join(', ')}.`,
          );
        }
        // A prefix will do, as in docker; resolveRecording explains itself
        // when one matches nothing or several things.
        const recording = await resolveRecording(context.store, id);

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
            context.ui.content(toPlainText(segments));
            return;
          case 'srt':
            context.ui.content(toSrt(segments));
            return;
          case 'vtt':
            context.ui.content(toVtt(segments));
            return;
          case 'json':
            context.ui.content(JSON.stringify({ recording, transcript, segments }, null, 2));
            return;
        }
      });
    });
}
