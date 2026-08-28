import { intro, log, outro, spinner } from '@clack/prompts';
import Table from 'cli-table3';
import stringWidth from 'string-width';
import { styleText } from 'node:util';
import { formatTimestamp } from '@laud/core';
import type { Recording, Transcript } from '@laud/core';
import type { Check, RecordingRow, Ui } from './types.js';

/** The `ls` table's column headings, and the order its cells are built in. */
const TABLE_HEAD = ['id', 'duration', 'lang', 'preview'] as const;

/** Width of clack's gutter prefix (`|` plus two spaces) on every rendered line. */
const GUTTER_WIDTH = 3;

/**
 * `@clack/prompts` plus `cli-table3`, selected when stdout is a real,
 * wide-enough terminal (see `createUi` in `./index.ts`). This is the
 * implementation the end-to-end suite never exercises -- it always runs
 * through a pipe -- so nothing here is under the byte-for-byte constraint
 * `PlainUi` carries.
 */
export class PrettyUi implements Ui {
  /**
   * `columns` is the terminal width the `ls` table has to fit inside.
   * Production always passes the measured width; the default stands for
   * "unbounded", which is what a unit test asserting on table content
   * wants, and what the table itself assumed before it learned to narrow.
   */
  public constructor(private readonly columns: number = Number.POSITIVE_INFINITY) {}

  public async frame<T>(label: string, task: () => Promise<T>): Promise<T> {
    // intro/outro go to stderr, not stdout: `show` relies on stdout
    // carrying only its transcript data, and every other command's stdout
    // is at least safe to keep free of a frame that wraps output already
    // written elsewhere. One rule for all five commands is simpler than a
    // per-command exception, and costs nothing.
    intro(label, { output: process.stderr });
    try {
      const result = await task();
      outro(`${label} done`, { output: process.stderr });
      return result;
    } catch (error) {
      // Just the outcome, not the message: the top-level handler prints
      // the error itself, and saying it in both places reads as two
      // separate problems.
      outro(`${label} failed`, { output: process.stderr });
      throw error;
    }
  }

  public imported(recording: Recording, alreadyPresent: boolean): void {
    const line = `${recording.id}  ${recording.sourcePath}`;
    if (alreadyPresent) {
      log.warn(`already present  ${line}`);
    } else {
      log.success(`imported  ${line}`);
    }
  }

  public async transcribing<T>(recording: Recording, task: () => Promise<T>): Promise<T> {
    const label = recording.title ?? recording.sourcePath;
    const s = spinner();
    s.start(`Transcribing ${recording.id}  ${label}`);
    try {
      const result = await task();
      s.stop(`Transcribed ${recording.id}  ${label}`);
      return result;
    } catch (error) {
      s.error(`Failed to transcribe ${recording.id}  ${label}`);
      throw error;
    }
  }

  public transcribed(recording: Recording, transcript: Transcript, segmentCount: number): void {
    log.success(
      `${recording.id}  ${transcript.language}  ${segmentCount} segment${segmentCount === 1 ? '' : 's'}`,
    );
  }

  public skipped(recording: Recording): void {
    log.warn(`${recording.id}  already transcribed (use --force)`);
  }

  public nothingToTranscribe(): void {
    log.info('Nothing to transcribe.');
  }

  public emptyLibrary(): void {
    log.info('The library is empty. Add something with "laud import".');
  }

  public recordings(rows: readonly RecordingRow[]): void {
    const cells = rows.map((row) => [
      row.id,
      formatTimestamp(row.durationMs, 'short'),
      row.language ?? '',
      row.preview,
    ]);

    if (!this.tableFits(cells)) {
      // Narrower than the table's own content needs. cli-table3 would wrap
      // cells mid-word inside borders that no longer line up, so drop the
      // borders and keep the data: one recording per gutter line, which
      // reads correctly at any width.
      for (const cell of cells) {
        log.message(cell.filter((value) => value !== '').join('  '));
      }
      return;
    }

    const table = new Table({
      head: [...TABLE_HEAD],
      // cli-table3's default head style is red, which reads as an error
      // next to clack's own red for failures. Dim keeps the header
      // legible without borrowing a color clack already assigns meaning.
      style: { head: ['dim'] },
    });
    for (const cell of cells) table.push(cell);
    // log.message, not note(): note() draws its own bordered frame, which
    // around an already-bordered table is a box inside a box. log.message
    // puts each line of the table under the gutter instead -- a list in
    // the gutter, not nested frames.
    log.message(table.toString());
  }

  /**
   * Whether the bordered table fits the terminal. Measured from the real
   * content with `string-width`, not `String.length`, because a CJK glyph
   * occupies two columns and this tool is deliberately multilingual --
   * counting code points would under-measure exactly the transcripts most
   * likely to overflow.
   */
  private tableFits(cells: readonly (readonly string[])[]): boolean {
    const widths = TABLE_HEAD.map((head, column) =>
      Math.max(stringWidth(head), ...cells.map((cell) => stringWidth(cell[column] ?? ''))),
    );
    // Each column costs its content plus two spaces of padding and one
    // border, and the table closes with a final border.
    const required = widths.reduce((total, width) => total + width + 3, 1);
    return required <= this.columns - GUTTER_WIDTH;
  }

  public checks(checks: readonly Check[]): void {
    // One multi-line message, not one call per check: clack puts a gutter
    // spacer between separate log calls, which doubles the height of a
    // seven-item checklist. Lines inside a single message stay contiguous.
    const lines: string[] = [];
    for (const check of checks) {
      const status = check.ok ? styleText('green', 'ok  ') : styleText('red', 'FAIL');
      lines.push(`${status}  ${check.name}  ${check.detail}`);
      if (!check.ok && check.fix !== undefined) {
        lines.push(`      fix: ${check.fix}`);
      }
    }
    log.message(lines.join('\n'));
  }
}
