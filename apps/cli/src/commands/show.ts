import type { Command } from 'commander';
import {
  FailureError,
  UsageError,
  formatRecordedAt,
  formatTimestamp,
  recordedOrImportedAt,
  segmentsOfSpeaker,
  speakerNameMap,
  summarizeSpeakers,
  toPlainText,
  toSrt,
  toVtt,
} from '@laud/core';
import type { Transcript } from '@laud/core';
import type { CliContext } from '../wiring.js';
import { resolveRecording, resolveTranscript } from '../resolveId.js';
import { page, shouldPage } from '@laud/providers';
import { speakerPainter } from '../ui/speakerColor.js';

const FORMATS = ['text', 'json', 'srt', 'vtt'] as const;
type Format = (typeof FORMATS)[number];

export function registerShow(program: Command, context: CliContext): void {
  program
    .command('show')
    .argument('<id>', 'recording id, or enough of its start to be unambiguous')
    .option('--format <format>', `one of ${FORMATS.join(', ')}`, 'text')
    .option('--speakers', 'list who spoke, instead of the transcript')
    .option('--speaker <who>', 'only this speaker, by diarizer label or by the name you gave them')
    .option(
      '--transcript <id>',
      'a specific transcript instead of the newest; a unique prefix will do',
    )
    .description('Print a transcript')
    .action(
      async (
        id: string,
        options: {
          format: string;
          transcript?: string;
          speakers?: boolean;
          speaker?: string;
        },
      ) => {
        // The transcript goes through ui.content(), not straight to stdout:
        // that puts it inside the frame for someone reading a terminal, while
        // a redirect or a pipe -- which selects PlainUi -- still receives the
        // exact bytes. See Ui.content.
        if (!FORMATS.includes(options.format as Format)) {
          throw new UsageError(
            `Unknown format "${options.format}". Use one of: ${FORMATS.join(', ')}.`,
          );
        }
        // Resolved BEFORE the frame opens, so the frame's title can name when
        // the recording was made. A prefix will do, as in docker;
        // resolveRecording explains itself when one matches nothing or
        // several things, and a failure here prints without an empty frame
        // wrapped around it.
        const recording = await resolveRecording(context.store, id);

        // The heading goes in the FRAME, never in the payload. `show --format
        // srt > out.srt` has to stay byte-exact, and a line of prose at the
        // top would corrupt the subtitle file. The frame is on stderr in
        // pretty mode and absent entirely when output is redirected, which is
        // exactly the distinction wanted here.
        const heading = `Transcript of ${formatRecordedAt(recordedOrImportedAt(recording))}`;

        await context.ui.frame(heading, async () => {
          // recording.id from here down, never `id`: `id` is whatever the user
          // typed, which may be a prefix. Looking a transcript up by the prefix
          // finds nothing and reports "no transcript yet" for a recording that
          // has one -- which is exactly what this did before the resolved id
          // was threaded through.
          let transcript: Transcript | null;
          if (options.transcript === undefined) {
            transcript = await context.store.latestTranscript(recording.id);
          } else {
            const candidate = await resolveTranscript(context.store, options.transcript);
            if (candidate.recordingId !== recording.id) {
              throw new FailureError(
                `${candidate.id} is not a transcript of recording ${recording.id}.`,
              );
            }
            transcript = candidate;
          }
          if (transcript === null) {
            throw new FailureError(
              `${recording.id} has no transcript yet. Run "laud transcribe ${recording.id}".`,
            );
          }
          const allSegments = await context.store.listSegments(transcript.id);
          const names = await context.store.listSpeakerNames(recording.id);

          if (options.speakers === true) {
            if (options.speaker !== undefined) {
              throw new UsageError(
                '--speakers lists who spoke and --speaker picks one of them; use one or the other.',
              );
            }
            const summary = summarizeSpeakers(allSegments, names);
            // Same reason as in toPlainText: pad by the plain name's width, so
            // colour codes cannot eat the alignment.
            const widestSpeaker = summary.reduce(
              (max, entry) => Math.max(max, Array.from(entry.name ?? entry.label).length),
              0,
            );
            const paintSummary = speakerPainter(
              summary.map((entry) => entry.name ?? entry.label),
              process.stdout.isTTY === true && options.format !== 'json',
            );
            if (summary.length === 0) {
              throw new FailureError(
                `${recording.id} has no speakers: it was transcribed without --diarize.`,
              );
            }
            context.ui.content(
              options.format === 'json'
                ? JSON.stringify(summary, null, 2)
                : summary
                    .map(
                      (speaker) =>
                        `${paintSummary(speaker.name ?? speaker.label)}` +
                        ' '.repeat(
                          widestSpeaker - Array.from(speaker.name ?? speaker.label).length + 2,
                        ) +
                        `${formatTimestamp(speaker.spokenMs, 'short')}  ` +
                        `${speaker.segmentCount} segment${speaker.segmentCount === 1 ? '' : 's'}` +
                        `${speaker.name === null ? '' : `  (${speaker.label})`}`,
                    )
                    .join('\n'),
            );
            return;
          }

          const segments =
            options.speaker === undefined
              ? allSegments
              : segmentsOfSpeaker(allSegments, names, options.speaker);
          if (options.speaker !== undefined && segments.length === 0) {
            // Names the alternatives rather than just failing: the user has a
            // label or a name in mind and got it slightly wrong, and the fix is
            // in front of them either way.
            const known = summarizeSpeakers(allSegments, names).map(
              (speaker) => speaker.name ?? speaker.label,
            );
            throw new FailureError(
              known.length === 0
                ? `${recording.id} has no speakers: it was transcribed without --diarize.`
                : `No speaker "${options.speaker}" in ${recording.id}. This recording has: ${known.join(', ')}.`,
            );
          }

          const nameMap = speakerNameMap(names);
          // Colour only when writing to a terminal. The same condition
          // createUi uses, and for the same reason: escape sequences belong on
          // a screen, never in a file someone redirected a transcript into.
          // Built from every speaker in this transcript at once, so no two of
          // them can be handed the same colour. Hashing alone collided in
          // practice: "Andrew" and "speaker_01" landed on the same purple in
          // a two-speaker transcript, which defeats the point of colouring
          // them at all. See assignSpeakerColors.
          const paint = speakerPainter(
            summarizeSpeakers(allSegments, names).map((entry) => entry.name ?? entry.label),
            process.stdout.isTTY === true,
          );

          const payload = ((): string => {
            switch (options.format as Format) {
              case 'text':
                return toPlainText(segments, nameMap, paint);
              case 'srt':
                return toSrt(segments);
              case 'vtt':
                return toVtt(segments);
              case 'json':
                return JSON.stringify(
                  { recording, transcript, segments, speakers: names },
                  null,
                  2,
                );
            }
          })();

          // A long transcript goes to the user's pager, where up, down and q
          // already work the way they do in git and man. Only when there is a
          // terminal to page on: shouldPage says no for a redirect or a pipe,
          // which want the bytes and would hang on a pager waiting for a
          // keypress nobody can give.
          if (shouldPage(payload, process.stdout.isTTY === true)) {
            await page(payload, (chunk) => context.ui.content(chunk));
            return;
          }
          context.ui.content(payload);
        });
      },
    );
}
