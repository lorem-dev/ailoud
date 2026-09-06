import type { Command } from 'commander';
import type { CliContext } from '../wiring.js';
import type { RecordingRow } from '../ui/index.js';
import { languageLabel } from '../ui/cells.js';
import { collectTag, parseTags } from '../tags.js';
import { truncateSample } from '@ailoud/core';

/** Characters of transcript text shown in the human-readable preview column. */
const PREVIEW_LENGTH = 60;

interface LsOptions {
  readonly json?: boolean;
  readonly tag?: string[];
}

interface LsRow {
  readonly id: string;
  readonly sourcePath: string;
  readonly title: string | null;
  readonly durationMs: number;
  readonly mime: string;
  readonly importedAt: string;
  readonly language: string | null;
  readonly transcriptId: string | null;
}

export function registerLs(program: Command, context: CliContext): void {
  program
    .command('ls')
    .option('--json', 'print one JSON array of rows instead of a table')
    .option('--tag <tag>', 'only recordings carrying this tag; repeatable', collectTag)
    .description('List recordings in the library')
    .action(async (options: LsOptions) => {
      await context.ui.frame('Library', async () => {
        const tags = parseTags(options.tag ?? []);
        const recordings = await context.store.listRecordings(tags.length === 0 ? {} : { tags });

        if (recordings.length === 0) {
          if (options.json === true) {
            // Through the Ui, exactly like the non-empty branch below, and
            // NOT on the raw channel. Raw looks like it protects the machine
            // contract, and does not: `PlainUi` is what runs whenever stdout
            // is not a terminal, so a pipe receives a bare `[]` either way.
            // What raw does do is print this one line at column 0 while the
            // frame is drawn around it -- verified in a sized pty. One branch
            // of one command must not render two different ways.
            context.ui.content('[]');
            return;
          }
          context.ui.emptyLibrary();
          return;
        }

        const rows: LsRow[] = [];
        const previews = new Map<string, string>();
        const transcriptIdByRecording = new Map<string, string>();
        for (const recording of recordings) {
          const transcript = await context.store.latestTranscript(recording.id);
          rows.push({
            id: recording.id,
            sourcePath: recording.sourcePath,
            title: recording.title,
            durationMs: recording.durationMs,
            mime: recording.mime,
            importedAt: recording.importedAt,
            language: transcript?.language ?? null,
            transcriptId: transcript?.id ?? null,
          });
          if (transcript !== null) {
            transcriptIdByRecording.set(recording.id, transcript.id);
            // truncateSample slices by code point (never splitting a surrogate
            // pair) and marks a shortened sample with an ellipsis, so a reader
            // can tell a clipped preview from a transcript that really is
            // this short. Quoting and escaping happen in the UI, which owns
            // presentation.
            previews.set(recording.id, truncateSample(transcript.text, PREVIEW_LENGTH));
          }
        }

        if (options.json === true) {
          // Unchanged on purpose: `language` here is the single code stored on
          // the transcript, which machine consumers read as one value. The
          // multi-language rendering below is for the human table only; the
          // per-segment languages are available from `show --format json`.
          context.ui.content(JSON.stringify(rows));
          return;
        }

        // One aggregate query for the whole listing rather than fetching each
        // recording's segments, which would mean loading every word in the
        // library to draw one column.
        const languagesByTranscript = await context.store.languagesByTranscript([
          ...transcriptIdByRecording.values(),
        ]);

        const displayRows: RecordingRow[] = rows.map((row) => {
          const transcriptId = transcriptIdByRecording.get(row.id);
          const languages =
            transcriptId === undefined ? [] : (languagesByTranscript.get(transcriptId) ?? []);
          return {
            id: row.id,
            durationMs: row.durationMs,
            language: languageLabel(languages, row.language),
            preview: previews.get(row.id) ?? '',
          };
        });
        context.ui.recordings(displayRows);
      });
    });
}
