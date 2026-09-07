import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { FailureError } from '@ailoud/core';

/**
 * The lock mechanism, shared by provisioning and by background jobs.
 *
 * Extracted rather than copied. The takeover path here was wrong twice
 * before it was right (see withExclusiveLock), and a second copy of it would
 * be wrong again in a way nobody would notice -- exactly the drift that made
 * summarizeRun.ts exist.
 */

/** What a held lock records, so a human can see who holds it. */
export interface LockHolder {
  readonly pid: number;
  readonly startedAt: string;
}

/** The messages a caller wants for each way `withExclusiveLock` can refuse. */
export interface LockMessages {
  readonly busy: (holder: LockHolder) => string;
  readonly stealing: string;
  readonly raced: string;
}

/**
 * Whether the process behind a pid is still running.
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. ESRCH means no such process, so the lock (or job) is stale. EPERM
 * means the process EXISTS but belongs to another user -- alive, and the most
 * dangerous case to get wrong, because treating it as stale would let two
 * runs proceed at once, which is the whole thing a lock exists to prevent.
 *
 * Exported so `jobs/store.ts`'s `withLiveness` and the e2e suite's cleanup
 * share this one implementation instead of each carrying their own copy --
 * this file's own header explains why a second copy of the lock logic is
 * exactly the mistake that made extracting it out of `setupLock.ts` necessary
 * in the first place.
 */
export function isRunning(pid: number): boolean {
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
 * The lock's live holder, or null when the lock is free or stale.
 *
 * Separate from taking the lock, and advisory only: a caller that wants to
 * refuse rather than block reads this, and must accept that the answer can
 * be out of date by the time it acts. See the parent/child split in the
 * design -- the parent reads this to give a synchronous refusal, and the
 * child still takes the real lock.
 */
export async function readLockHolder(path: string): Promise<LockHolder | null> {
  const holder = await readHolder(path);
  if (holder === null) return null;
  return isRunning(holder.pid) ? holder : null;
}

/**
 * Takes an exclusive lock for the duration of `body`.
 *
 * Acquired by creating the file with the `wx` flag, which fails if it
 * already exists. That is one atomic syscall; a check followed by a create
 * would leave a window for the other process to win in between, which is
 * exactly the race being closed.
 *
 * Taking over a stale lock cannot use `wx`, since the file is there, so the
 * takeover runs under a second lock (`<path>.steal`) created with `wx`. That
 * makes the takeover itself exclusive -- one winner, and the loser told to
 * try again. Checking afterwards who won is not enough: two runs can each
 * check after their own write and each see themselves.
 *
 * A live lock is refused immediately rather than waited on. A caller that
 * cannot proceed is better told so than left watching a queued run that is,
 * from the outside, indistinguishable from a hung one -- each caller's own
 * doc comment gives its specific reason for that. The refusal names the
 * holder's pid and start time so the user can decide whether to wait or go
 * and look at it.
 *
 * A stale lock is taken over. After a crash or a Ctrl-C that skipped
 * cleanup, the file outlives its process, and a lock nobody can ever
 * release would be worse than no lock at all.
 */
export async function withExclusiveLock<T>(
  path: string,
  messages: LockMessages,
  body: () => Promise<T>,
): Promise<T> {
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
      throw new FailureError(messages.busy(existing));
    }

    // Stale: the holder is gone, or never finished writing who it was.
    //
    // Two earlier attempts at this were wrong in the same way -- they made the
    // takeover look exclusive without making it exclusive. `rm` then create
    // let a second run become a live holder in between and then deleted its
    // lock. Rename-then-read-back looked safer but is not: the interleaving
    // A.rename, A.read, B.rename, B.read leaves each run reading its own pid,
    // and both proceed. A concurrency test found 34 overlaps in 60 runs.
    //
    // Exclusion has to be on the takeover itself, so it runs through a second
    // lock created with `wx` -- one atomic syscall, one winner. The loser is
    // told to try again rather than being allowed to guess.
    const steal = `${path}.steal`;
    let stealHandle;
    try {
      stealHandle = await open(steal, 'wx');
    } catch (stealError) {
      if ((stealError as NodeJS.ErrnoException).code !== 'EEXIST') throw stealError;
      throw new FailureError(messages.stealing);
    }

    try {
      // Re-read under the steal lock: between the check above and here, the
      // stale lock may have been taken by a run that is now alive.
      const current = await readHolder(path);
      if (current !== null && isRunning(current.pid)) {
        throw new FailureError(messages.busy(current));
      }
      await rm(path, { force: true });
      // Still `wx`: a run on the fast path can create the lock in the instant
      // after that `rm`, and it is then the holder. Losing to it is the
      // correct outcome, not something to overwrite.
      //
      // CodeQL reads this as a check-then-use race (js/file-system-race) and
      // cannot see that the exclusion is held by `${path}.steal` above. The
      // rule is excluded in .github/codeql/codeql-config.yml, where the
      // reasoning lives; what actually guards this is the two-process test in
      // setupLock.test.ts.
      try {
        const handle = await open(path, 'wx');
        try {
          await handle.writeFile(mine, 'utf8');
        } finally {
          await handle.close();
        }
      } catch (createError) {
        if ((createError as NodeJS.ErrnoException).code !== 'EEXIST') throw createError;
        throw new FailureError(messages.raced);
      }
    } finally {
      await stealHandle.close();
      await rm(steal, { force: true });
    }
  }

  try {
    return await body();
  } finally {
    // Only our own lock. Removing it unconditionally would delete the lock of
    // a run that legitimately took over after ours was declared stale, letting
    // a third run in while that one is still working.
    //
    // force: a lock already gone is the outcome we wanted anyway, and failing
    // to clean up must never mask what the body was doing.
    const held = await readHolder(path);
    if (held === null || held.pid === process.pid) await rm(path, { force: true });
  }
}
