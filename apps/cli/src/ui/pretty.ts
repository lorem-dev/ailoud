import { log, note, spinner } from '@clack/prompts';
import Table from 'cli-table3';
import { formatTimestamp } from '@laud/core';
import type { Recording, Transcript } from '@laud/core';
import type { Check, RecordingRow, Ui } from './types.js';

/**
 * `@clack/prompts` plus `cli-table3`, selected when stdout is a real
 * terminal (`process.stdout.isTTY`). This is the implementation the
 * end-to-end suite never exercises -- it always runs through a pipe -- so
 * nothing here is under the byte-for-byte constraint `PlainUi` carries.
 */
export class PrettyUi implements Ui {
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
    const table = new Table({ head: ['id', 'duration', 'lang', 'preview'] });
    for (const row of rows) {
      table.push([
        row.id,
        formatTimestamp(row.durationMs, 'short'),
        row.language ?? '',
        row.preview,
      ]);
    }
    note(table.toString(), 'Recordings');
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
