import { formatTimestamp } from '@laud/core';
import type { Recording, Transcript } from '@laud/core';
import type { Check, RecordingRow, Ui } from './types.js';
import { checkStatus, languageLabel, optionalNote, previewCell } from './cells.js';

/** Width of the leading "ok"/"FAIL"/"n/a" column in `checks()`, including its trailing padding. */
const STATUS_WIDTH = 6;
/** Width of the check-name column in `checks()`, including its trailing padding. */
const NAME_WIDTH = 22;

/**
 * Reproduces today's output byte for byte: every line below is exactly
 * what the commands used to build and pass to `context.out` before this
 * module existed. This is the implementation the end-to-end suite always
 * exercises, because it always runs through a pipe (`process.stdout.isTTY`
 * is false there), so nothing in `e2e/tests/pipeline.spec.ts` needed to
 * change for this UI layer to land.
 */
export class PlainUi implements Ui {
  public constructor(private readonly write: (line: string) => void) {}

  public async frame<T>(_label: string, task: () => Promise<T>): Promise<T> {
    // No intro/outro chrome in plain mode: it is not part of today's
    // output and would not be byte-for-byte if it were. The frame still
    // wraps and rethrows exactly like PrettyUi's does, so a command
    // behaves identically either way -- only the decoration differs.
    return task();
  }

  public content(text: string): void {
    // Verbatim. PlainUi is what runs whenever stdout is not a terminal, so
    // this is the path a redirect or a pipe takes, and a single added
    // character would corrupt the subtitle file or break the JSON parser on
    // the other end.
    this.write(text);
  }

  public imported(recording: Recording, alreadyPresent: boolean): void {
    this.write(
      `${recording.id}  ${alreadyPresent ? 'already present' : 'imported'}  ${recording.sourcePath}`,
    );
  }

  public async transcribing<T>(_recording: Recording, task: () => Promise<T>): Promise<T> {
    // No progress output while the work runs: whisper.cpp already prints
    // nothing on its own, and the plain path must match that silence.
    return task();
  }

  public transcribed(
    recording: Recording,
    transcript: Transcript,
    segmentCount: number,
    languages: readonly string[],
  ): void {
    this.write(
      `${recording.id}  ${languageLabel(languages, transcript.language)}  ${segmentCount} segment${segmentCount === 1 ? '' : 's'}`,
    );
  }

  public skipped(recording: Recording): void {
    this.write(`${recording.id}  already transcribed (use --force)`);
  }

  public nothingToTranscribe(): void {
    this.write('Nothing to transcribe.');
  }

  public emptyLibrary(): void {
    this.write('The library is empty. Add something with "laud import".');
  }

  public recordings(rows: readonly RecordingRow[]): void {
    for (const row of rows) {
      const duration = formatTimestamp(row.durationMs, 'short');
      // A recording with no transcript yet (right after import, before
      // transcribe) still gets a row; its language and preview columns
      // just come out empty. trimEnd keeps that row from trailing off
      // into blank columns nobody can see.
      this.write(
        `${row.id}  ${duration}  ${row.language ?? ''}  ${previewCell(row.preview)}`.trimEnd(),
      );
    }
  }

  public checks(checks: readonly Check[]): void {
    for (const check of checks) {
      // Three states, not two -- see checkStatus. An optional failure still
      // gets its fix line: it is the one thing that tells the reader how to
      // turn the feature on if they want it.
      const status = checkStatus(check).padEnd(STATUS_WIDTH);
      this.write(`${status}${check.name.padEnd(NAME_WIDTH)}${check.detail}`);
      if (!check.ok && check.fix !== undefined) {
        this.write(`${' '.repeat(STATUS_WIDTH)}fix: ${check.fix}`);
      }
    }
    const note = optionalNote(checks);
    // Unpadded, so it reads as a note about the list rather than as another
    // row of it.
    if (note !== null) this.write(`note: ${note}`);
  }

  public warn(message: string): void {
    this.write(`warning: ${message}`);
  }
}
