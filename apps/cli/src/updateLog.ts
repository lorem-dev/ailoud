import { randomUUID } from 'node:crypto';
import type { Fs } from '@ailoud/core';

/** The log is truncated once it grows past this many bytes. */
const MAX_BYTES = 1024 * 1024; // 1 MB

/** How many of the most recent lines survive a truncation. */
/** How many times an append will retry a lost race before dropping the line. */
const MAX_ATTEMPTS = 5;

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
 * Two processes racing here used to lose an entry outright: both read the
 * same bytes, both built "everything so far, plus my line", and whichever
 * wrote last replaced the file with only ITS line appended -- the other's
 * was gone, with no error anywhere. The same read-modify-write race
 * `projects.ts` was redesigned to avoid for the project registry.
 *
 * An O_APPEND write is the textbook fix for exactly this shape of race: the
 * kernel serializes small appends, so neither writer's bytes are ever
 * discarded no matter how the two calls interleave. The `Fs` port has no
 * such primitive, though -- only whole-file `writeTextFile`/`rename` -- so
 * that is not available here. Instead this detects the conflict itself:
 * after building the candidate content and
 * writing it to a temp file, it re-reads the real log and checks whether it
 * still matches what this call read at the start. If another writer
 * committed in between, the temp file is discarded and the whole
 * read-build-write is retried against the fresh content, until a rename
 * lands against the same bytes it was built from. That narrows the race to
 * the gap between that last re-read and the rename -- not zero, the same
 * residual window `writeRegistry` (`projects.ts`) documents and accepts for
 * the same reason -- without a lock: this is an occasional diagnostic
 * append, not a hot path, so a retry costs nothing worth avoiding.
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
  await deps.fs.ensureDir(deps.userDataDir);

  // Bounded, deliberately. The loop only spins on genuine contention -- a
  // persistent failure throws instead -- so an unbounded `for (;;)` needs a
  // continuous stream of rival writers to hang, which a once-per-update
  // diagnostic append will not see. Two lines is a cheap price for removing
  // the possibility altogether, and dropping the line is the right answer on
  // giving up: this file exists to explain what happened, and losing one
  // entry is incomparably better than hanging the command that was writing
  // it. The same rule the project registry follows.
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const before = (await deps.fs.exists(path)) ? await deps.fs.readTextFile(path) : '';
    const appended = `${before}${line}\n`;
    const next =
      Buffer.byteLength(appended, 'utf8') > MAX_BYTES
        ? keepLastLines(appended, MAX_LINES)
        : appended;

    const tempPath = `${path}.${randomUUID()}.tmp`;
    try {
      await deps.fs.writeTextFile(tempPath, next);
    } catch (error) {
      // The target has not been touched yet, so there is nothing to undo.
      // Clear the partial temporary file rather than leaving litter behind.
      await deps.fs.removeFile(tempPath);
      throw error;
    }

    const current = (await deps.fs.exists(path)) ? await deps.fs.readTextFile(path) : '';
    if (current !== before) {
      // Someone else committed while this attempt was being built: discard
      // it and retry against what is actually on disk now, rather than
      // renaming over -- and silently erasing -- their line.
      await deps.fs.removeFile(tempPath);
      continue;
    }
    await deps.fs.rename(tempPath, path);
    return;
  }
  // Every attempt lost the race. Dropping the line is correct -- see above.
}
