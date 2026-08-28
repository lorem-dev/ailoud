import type { Command } from 'commander';
import type { CliContext } from '../wiring.js';
import type { RecordingRow } from '../ui/index.js';

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
          context.write(JSON.stringify(rows));
          return;
        }

        const displayRows: RecordingRow[] = rows.map((row) => ({
          id: row.id,
          durationMs: row.durationMs,
          language: row.language,
          preview: previews.get(row.id) ?? '',
        }));
        context.ui.recordings(displayRows);
      });
    });
}
