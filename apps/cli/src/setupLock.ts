import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { FailureError } from '@ailoud/core';

/** What a held lock records, so a human can see who holds it. */
interface LockHolder {
  readonly pid: number;
  readonly startedAt: string;
}

export function lockPath(dataDir: string): string {
  return join(dataDir, 'provisioning.lock');
}

/**
 * Whether the process that wrote a lock is still running.
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. ESRCH means no such process, so the lock is stale. EPERM means
 * the process EXISTS but belongs to another user -- a live lock, and the
 * most dangerous case to get wrong, because treating it as stale would let
 * two runs proceed at once, which is the whole thing this prevents.
 */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Reads a lock file, or reports it unreadable.
 *
 * A file that exists but is empty, truncated, or not valid JSON is a run
 * that died between creating the lock and writing to it. That is stale by
 * definition, and must not surface to the user as a parse error about a
 * file they have never heard of.
 */
async function readHolder(path: string): Promise<LockHolder | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { pid, startedAt } = parsed as Partial<LockHolder>;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
    if (typeof startedAt !== 'string' || startedAt === '') return null;
    return { pid, startedAt };
  } catch {
    return null;
  }
}

/**
 * Takes an exclusive lock for the duration of `body`.
 *
 * Provisioning downloads into shared scratch paths under the data
 * directory, so two runs at once can delete or truncate a file the other is
 * streaming. Before this, that produced a confusing failure rather than a
 * clean refusal.
 *
 * Acquired by creating the file with the `wx` flag, which fails if it
 * already exists. That is one atomic syscall; a check followed by a create
 * would leave a window for the other process to win in between, which is
 * exactly the race being closed.
 *
 * Taking over a stale lock cannot use `wx`, since the file is there. It writes
 * a lock beside it and renames over the path -- atomic, and overwriting -- then
 * reads the file back. Two runs can both rename; only one is in the file
 * afterwards, and the other sees a pid that is not its own and refuses.
 *
 * A live lock is refused immediately rather than waited on. Provisioning is
 * interactive and can sit on a consent prompt for minutes, so a queued
 * second run would look like a hang. The refusal names the holder's pid and
 * start time so the user can decide whether to wait or go and look at it.
 *
 * A stale lock is taken over. After a crash or a Ctrl-C that skipped
 * cleanup, the file outlives its process, and a lock nobody can ever
 * release would be worse than no lock at all.
 */
export async function withProvisioningLock<T>(dataDir: string, body: () => Promise<T>): Promise<T> {
  const path = lockPath(dataDir);
  await mkdir(dirname(path), { recursive: true });

  const holder: LockHolder = { pid: process.pid, startedAt: new Date().toISOString() };
  const mine = JSON.stringify(holder);

  try {
    const handle = await open(path, 'wx');
    try {
      await handle.writeFile(mine, 'utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

    const existing = await readHolder(path);
    if (existing !== null && isRunning(existing.pid)) {
      throw new FailureError(
        `another ailoud provisioning run is already in progress (pid ${existing.pid}, started ` +
          `${existing.startedAt}). Wait for it to finish, or stop it, then try again.`,
      );
    }

    // Stale: the holder is gone, or never finished writing who it was. Taking
    // it over used to be `rm` then create -- which loses the race it looks
    // like it wins. Between reading the holder and removing the file, another
    // run can take the same stale lock and become a LIVE holder; the `rm` then
    // deletes a live lock and both runs proceed, which is the one outcome this
    // whole file exists to prevent.
    //
    // So: write our own lock beside it and `rename` over the path. Rename is
    // atomic and overwrites, so two takeovers both "succeed" -- but only one
    // of them is in the file afterwards. Reading it back is what settles it.
    const scratch = `${path}.${process.pid}.${process.hrtime.bigint()}`;
    const handle = await open(scratch, 'wx');
    try {
      await handle.writeFile(mine, 'utf8');
    } finally {
      await handle.close();
    }
    try {
      await rename(scratch, path);
    } catch (renameError) {
      await rm(scratch, { force: true });
      throw renameError;
    }

    const settled = await readHolder(path);
    if (settled?.pid !== process.pid) {
      throw new FailureError(
        'another ailoud provisioning run took over the lock at the same moment. Try again.',
      );
    }
  }

  try {
    return await body();
  } finally {
    // force: a lock already gone is the outcome we wanted anyway, and
    // failing to clean up must never mask what the body was doing.
    await rm(path, { force: true });
  }
}
