import type { Fs } from '@ailoud/core';

/** The log is truncated once it grows past this many bytes. */
const MAX_BYTES = 1024 * 1024; // 1 MB

/** How many of the most recent lines survive a truncation. */
const MAX_LINES = 500;

export interface UpdateLogDeps {
  readonly fs: Fs;
  readonly userDataDir: string;
}

/**
 * Where the plain-text log of `self sync` and `self update` actions lives.
 * Per-user, like the project registry: it must never live inside a project's
 * own `.ailoud/`, or it would only ever record that one project's history.
 */
export function updateLogPath(userDataDir: string): string {
  return `${userDataDir}/update.log`;
}

/**
 * Keeps only the last `maxLines` lines of `text`.
 *
 * `text` always ends in exactly one trailing newline (every write this
 * module makes ends that way), so splitting on "\n" leaves one empty
 * element at the end that is not a line of its own -- it is dropped before
 * slicing, and the `join` below adds the trailing newline back.
 */
function keepLastLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  const last = lines[lines.length - 1];
  const withoutTrailingEmpty = last === '' ? lines.slice(0, -1) : lines;
  const kept = withoutTrailingEmpty.slice(-maxLines);
  return kept.length === 0 ? '' : `${kept.join('\n')}\n`;
}

/**
 * Appends one line to the update log, creating it (and its directory) on
 * first use.
 *
 * Truncated to the last 500 lines once the file passes 1 MB, so a machine
 * ailoud has run on for years does not grow this file forever. The check
 * runs after every append rather than on a schedule, because the file is
 * never large enough for that read-and-measure to be a cost worth avoiding.
 *
 * Callers must never pass a credential or any transcript text: this line is
 * meant to be safe to paste into a bug report.
 */
export async function appendUpdateLog(deps: UpdateLogDeps, line: string): Promise<void> {
  const path = updateLogPath(deps.userDataDir);
  const before = (await deps.fs.exists(path)) ? await deps.fs.readTextFile(path) : '';
  const appended = `${before}${line}\n`;
  const next =
    Buffer.byteLength(appended, 'utf8') > MAX_BYTES ? keepLastLines(appended, MAX_LINES) : appended;
  await deps.fs.ensureDir(deps.userDataDir);
  await deps.fs.writeTextFile(path, next);
}
