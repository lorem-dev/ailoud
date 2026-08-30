import type { Command } from 'commander';
import type { CliContext } from '../wiring.js';
import type { RecordingRow } from '../ui/index.js';
import { languageLabel } from '../ui/languageLabel.js';

/** Characters of transcript text shown in the human-readable preview column. */
const PREVIEW_LENGTH = 60;

interface LsOptions {
  readonly json?: boolean;
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
    .description('List recordings in the library')
    .action(async (options: LsOptions) => {
      await context.ui.frame('Library', async () => {
        const recordings = await context.store.listRecordings({});

        if (recordings.length === 0) {
          if (options.json === true) {
            context.write('[]');
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
            // Slice by code point, not UTF-16 code unit: a plain .slice() can
            // land inside a surrogate pair (any astral-plane character, e.g.
            // emoji or some CJK extension characters) and emit a lone
            // surrogate. Transcripts are multilingual by design, so this is
            // not a hypothetical edge case.
            const preview = Array.from(transcript.text).slice(0, PREVIEW_LENGTH).join('');
            previews.set(recording.id, preview);
          }
        }

        if (options.json === true) {
          // Unchanged on purpose: `language` here is the single code stored on
          // the transcript, which machine consumers read as one value. The
          // multi-language rendering below is for the human table only; the
          // per-segment languages are available from `show --format json`.
          context.write(JSON.stringify(rows));
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
