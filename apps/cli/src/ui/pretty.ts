import { intro, log, outro, spinner } from '@clack/prompts';
import Table from 'cli-table3';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import { styleText } from 'node:util';
import { formatDuration, formatTimestamp } from '@laud/core';
import type { Recording, Transcript } from '@laud/core';
import type { Check, RecordingRow, Ui } from './types.js';
import { checkStatus, languageLabel, optionalNote, previewCell } from './cells.js';

/** The `ls` table's column headings, and the order its cells are built in. */
const TABLE_HEAD = ['id', 'duration', 'lang', 'preview'] as const;

/** Width of clack's gutter prefix (`|` plus two spaces) on every rendered line. */
const GUTTER_WIDTH = 3;

/**
 * Below this, a frame closes with a bare "Done". A command that finishes
 * faster than a person can notice does not need its duration reported.
 */
const DURATION_FLOOR_MS = 1000;

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
  public constructor(
    private readonly columns: number = Number.POSITIVE_INFINITY,
    // Monotonic by default, so a clock adjustment mid-transcription cannot
    // produce a negative or wildly wrong duration. Injectable so the tests
    // can assert an exact string instead of a moving number.
    private readonly now: () => number = () => performance.now(),
  ) {}

  public async frame<T>(label: string, task: () => Promise<T>): Promise<T> {
    // intro/outro go to stderr, not stdout: `show` relies on stdout
    // carrying only its transcript data, and every other command's stdout
    // is at least safe to keep free of a frame that wraps output already
    // written elsewhere. One rule for all five commands is simpler than a
    // per-command exception, and costs nothing.
    intro(this.wrap(label), { output: process.stderr });
    const startedAt = this.now();
    try {
      const result = await task();
      outro(styleText('green', `Done${this.took(startedAt)}`), { output: process.stderr });
      return result;
    } catch (error) {
      // The outcome alone. The label already opened the frame, and the
      // top-level handler prints the error itself -- saying either again
      // here reads as a second, separate problem.
      outro(styleText('red', `Failed${this.took(startedAt)}`), { output: process.stderr });
      throw error;
    }
  }

  /**
   * The elapsed-time suffix for a frame's closing line, or nothing.
   *
   * Only commands that actually took a while report their runtime. `laud ls`
   * finishing in four milliseconds does not need a stopwatch reading, and
   * printing one on every command would turn a useful signal for
   * `transcribe` into noise everywhere else.
   *
   * Reported for a failure too, not just a success: knowing a transcription
   * ran for three minutes before dying is exactly as useful as knowing it
   * ran for three minutes and worked.
   */
  private took(startedAt: number): string {
    const elapsedMs = this.now() - startedAt;
    if (elapsedMs < DURATION_FLOOR_MS) return '';
    return ` in ${formatDuration(elapsedMs)}`;
  }

  public content(text: string): void {
    // Inside the frame, wrapped to the terminal's width: an unwrapped
    // transcript line longer than the terminal tears through the frame's
    // gutter, which is exactly the breakage this rendering exists to avoid.
    //
    // Trailing newlines are trimmed because the formatters end their output
    // with one; passing it through would draw an empty gutter line before
    // the frame closes.
    log.message(this.wrap(text.replace(/\n+$/, '')));
  }

  public imported(recording: Recording, alreadyPresent: boolean): void {
    const line = `${recording.id}  ${recording.sourcePath}`;
    if (alreadyPresent) {
      log.warn(this.wrap(`already present  ${line}`));
    } else {
      log.success(this.wrap(`imported  ${line}`));
    }
  }

  /**
   * Trims a spinner line to one terminal row, keeping the END of `tail`.
   *
   * A spinner is the one place `wrap()` must NOT be used. clack redraws it
   * with ESC[1G ESC[J -- go to column one, erase forward -- which clears
   * exactly one visual row. A message wider than the terminal wraps onto
   * several rows, the redraw then clears only the last of them, and every
   * frame leaves its predecessor behind: the animation turns into a column
   * of identical lines. That is what an unbounded `id + full source path`
   * did on a 75-column terminal, where the line measured 155 characters.
   *
   * The tail is what survives, not the head: `tail` is a path, and a
   * filename identifies a recording to a person far better than the leading
   * directories do.
   */
  private fitSpinnerLine(head: string, tail: string): string {
    if (!Number.isFinite(this.textWidth)) return `${head}  ${tail}`;
    // clack prints its own glyph and two spaces ahead of the message, the
    // same shape as the gutter, so the budget is the gutter's width again.
    const budget = this.textWidth - GUTTER_WIDTH - stringWidth(`${head}  `);
    if (budget <= 0) return head;
    if (stringWidth(tail) <= budget) return `${head}  ${tail}`;
    const ellipsis = '...';
    const keep = Math.max(0, budget - ellipsis.length);
    const characters = Array.from(tail);
    let trimmed = '';
    // Walk backwards so the filename survives, measuring as we go: a path
    // can hold wide characters, for which one code point is two columns.
    for (let i = characters.length - 1; i >= 0; i -= 1) {
      const next = `${characters[i] ?? ''}${trimmed}`;
      if (stringWidth(next) > keep) break;
      trimmed = next;
    }
    return `${head}  ${ellipsis}${trimmed}`;
  }

  public async transcribing<T>(recording: Recording, task: () => Promise<T>): Promise<T> {
    const label = recording.title ?? recording.sourcePath;
    const s = spinner();
    s.start(this.fitSpinnerLine(`Transcribing ${recording.id}`, label));
    try {
      const result = await task();
      s.stop(this.fitSpinnerLine(`Transcribed ${recording.id}`, label));
      return result;
    } catch (error) {
      s.error(this.fitSpinnerLine(`Failed to transcribe ${recording.id}`, label));
      throw error;
    }
  }

  public transcribed(
    recording: Recording,
    transcript: Transcript,
    segmentCount: number,
    languages: readonly string[],
  ): void {
    log.success(
      this.wrap(
        `${recording.id}  ${languageLabel(languages, transcript.language)}  ${segmentCount} segment${segmentCount === 1 ? '' : 's'}`,
      ),
    );
  }

  public skipped(recording: Recording): void {
    log.warn(this.wrap(`${recording.id}  already transcribed (use --force)`));
  }

  public nothingToTranscribe(): void {
    log.info(this.wrap('Nothing to transcribe.'));
  }

  public emptyLibrary(): void {
    log.info(this.wrap('The library is empty. Add something with "laud import".'));
  }

  public recordings(rows: readonly RecordingRow[]): void {
    const cells = rows.map((row) => [
      row.id,
      formatTimestamp(row.durationMs, 'short'),
      row.language ?? '',
      previewCell(row.preview),
    ]);

    if (!this.tableFits(cells)) {
      // Narrower than the table's own content needs. cli-table3 would wrap
      // cells mid-word inside borders that no longer line up, so drop the
      // borders and keep the data: one recording per gutter line, which
      // reads correctly at any width.
      for (const cell of cells) {
        log.message(this.wrap(cell.filter((value) => value !== '').join('  ')));
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
   * Columns available to a line's own text once clack's gutter -- the
   * three-column symbol-plus-spaces prefix (`|  `, or the frame's
   * top/bottom corner in `frame`) it draws on every line -- is
   * subtracted. `columns` defaults to `Infinity` for the "unbounded" case
   * a unit test wants, and that stays `Infinity` here too: there is no
   * terminal to overflow, so nothing needs wrapping.
   */
  private get textWidth(): number {
    return this.columns - GUTTER_WIDTH;
  }

  /**
   * Wraps `text` so every line it produces fits within `textWidth`, then
   * indents every line after the first by `indent` columns so a
   * continuation lines up under a column of the caller's choosing rather
   * than restarting at the gutter -- which is what the terminal itself
   * does, with no knowledge of the gutter, if this class hands it a line
   * that does not already fit. Wrapping is hard, not soft: a path or a
   * version string has no spaces to break at, and a soft wrap would let
   * exactly that kind of token overflow instead of wrapping it.
   */
  private wrap(text: string, indent = 0): string {
    if (!Number.isFinite(this.textWidth)) {
      return text;
    }
    const width = Math.max(1, this.textWidth - indent);
    const wrapped = wrapAnsi(text, width, { hard: true });
    if (indent === 0) {
      return wrapped;
    }
    const pad = ' '.repeat(indent);
    return wrapped
      .split('\n')
      .map((line, index) => (index === 0 ? line : `${pad}${line}`))
      .join('\n');
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
    return required <= this.textWidth;
  }

  public checks(checks: readonly Check[]): void {
    // Pad the names into a column so the details line up and the list can be
    // scanned down rather than read across, the way plain mode does it.
    const nameWidth = Math.max(...checks.map((check) => stringWidth(check.name)));
    // Display-column width of the fixed "status  name  " prefix before the
    // detail column: "ok  "/"FAIL" (4) plus two spaces, the padded name, and
    // two more spaces. A wrapped detail indents by this much so its
    // continuation lines up under the detail column.
    const detailIndent = nameWidth + 8;
    const FIX_PREFIX = '      fix: ';
    for (const check of checks) {
      // One call per check: clack draws its glyph in place of the gutter
      // character, so the status reads down the frame itself. That is worth
      // the blank gutter line clack puts between separate calls -- grouping
      // them into one message would leave one glyph for the whole list.
      // Three states, not two -- see checkStatus. Yellow for the optional
      // failure, between clack's green and red, because that is exactly what
      // it means: not right, not fatal. Padded to four columns like the other
      // two so the name column stays aligned down the list.
      const word = checkStatus(check);
      const status =
        word === 'ok'
          ? styleText('green', 'ok  ')
          : word === 'n/a'
            ? styleText('yellow', 'n/a ')
            : styleText('red', 'FAIL');
      const detail = this.wrap(check.detail, detailIndent);
      const lines = [`${status}  ${check.name.padEnd(nameWidth)}  ${detail}`];
      if (!check.ok && check.fix !== undefined) {
        // Inside the same message, so it takes a plain gutter and reads as
        // part of the check above rather than as an entry of its own.
        lines.push(`${FIX_PREFIX}${this.wrap(check.fix, FIX_PREFIX.length)}`);
      }
      // clack's own log.success / log.warn / log.error rather than a custom
      // symbol: it owns these glyphs -- a diamond for pass, a triangle for a
      // warning, a square for failure -- and colors them itself, so the
      // checklist matches every other framed tool the user runs instead of
      // inventing a private vocabulary. The first line takes the glyph in
      // place of the gutter; a fix line inside the same message takes a plain
      // gutter and reads as part of the check.
      const emit = word === 'ok' ? log.success : word === 'n/a' ? log.warn : log.error;
      emit(lines.join('\n'));
    }
    const note = optionalNote(checks);
    // log.info, not log.warn: the rows themselves already carry the warning
    // glyph, and this line exists to say the run is fine in spite of them.
    if (note !== null) log.info(this.wrap(note));
  }

  public warn(message: string): void {
    log.warn(this.wrap(message));
  }
}
