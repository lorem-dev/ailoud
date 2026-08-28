import { intro, log, outro, spinner } from '@clack/prompts';
import Table from 'cli-table3';
import { formatTimestamp } from '@laud/core';
import type { Recording, Transcript } from '@laud/core';
import type { Check, RecordingRow, Ui } from './types.js';

/** Extracts a message from whatever a command's action threw, without assuming it is an Error. */
function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `@clack/prompts` plus `cli-table3`, selected when stdout is a real,
 * wide-enough terminal (see `createUi` in `./index.ts`). This is the
 * implementation the end-to-end suite never exercises -- it always runs
 * through a pipe -- so nothing here is under the byte-for-byte constraint
 * `PlainUi` carries.
 */
export class PrettyUi implements Ui {
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
      outro(`${label} failed: ${messageFor(error)}`, { output: process.stderr });
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
    const table = new Table({
      head: ['id', 'duration', 'lang', 'preview'],
      // cli-table3's default head style is red, which reads as an error
      // next to clack's own red for failures. Dim keeps the header
      // legible without borrowing a color clack already assigns meaning.
      style: { head: ['dim'] },
    });
    for (const row of rows) {
      table.push([
        row.id,
        formatTimestamp(row.durationMs, 'short'),
        row.language ?? '',
        row.preview,
      ]);
    }
    // log.message, not note(): note() draws its own bordered frame, which
    // around an already-bordered table is a box inside a box. log.message
    // puts each line of the table under the gutter instead -- a list in
    // the gutter, not nested frames.
    log.message(table.toString());
  }

  public checks(checks: readonly Check[]): void {
    for (const check of checks) {
      const line = `${check.name}  ${check.detail}`;
      if (check.ok) {
        log.success(line);
      } else {
        log.error(line);
        if (check.fix !== undefined) {
          log.message(`  fix: ${check.fix}`);
        }
      }
    }
  }
}
