import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { FailureError } from '@laud/core';

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

  let handle;
  try {
    handle = await open(path, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

    const holder = await readHolder(path);
    if (holder !== null && isRunning(holder.pid)) {
      throw new FailureError(
        `another laud provisioning run is already in progress (pid ${holder.pid}, started ` +
          `${holder.startedAt}). Wait for it to finish, or stop it, then try again.`,
      );
    }
    // Stale: the holder is gone, or never finished writing who it was.
    await rm(path, { force: true });
    handle = await open(path, 'wx');
  }

  try {
    const holder: LockHolder = { pid: process.pid, startedAt: new Date().toISOString() };
    await handle.writeFile(JSON.stringify(holder), 'utf8');
  } finally {
    await handle.close();
  }

  try {
    return await body();
  } finally {
    // force: a lock already gone is the outcome we wanted anyway, and
    // failing to clean up must never mask what the body was doing.
    await rm(path, { force: true });
  }
}
