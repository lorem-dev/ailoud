import { join } from 'node:path';
import { readLockHolder, withExclusiveLock } from '../exclusiveLock.js';
import type { LockHolder } from '../exclusiveLock.js';

export function jobLockPath(dataDir: string): string {
  return join(dataDir, 'jobs.lock');
}

/**
 * One background job at a time, per library.
 *
 * Not a throughput choice. whisper takes every core it is given -- measured
 * at 4 threads on this machine -- so two concurrent jobs make both slower
 * and neither finishes sooner.
 *
 * Refused rather than queued, like provisioning: a queued job reporting 0%
 * for an hour is indistinguishable from a hung one.
 */
export function withJobLock<T>(dataDir: string, body: () => Promise<T>): Promise<T> {
  return withExclusiveLock(
    jobLockPath(dataDir),
    {
      busy: (holder) =>
        `another ailoud job is already running (pid ${holder.pid}, started ${holder.startedAt}). ` +
        'Wait for it to finish, or stop it, then try again.',
      stealing: 'another ailoud job is taking over a stale lock right now. Try again.',
      raced: 'another ailoud job took the lock at the same moment. Try again.',
    },
    body,
  );
}

/** Who holds the job lock, for a caller that wants to refuse up front. Advisory. */
export function jobLockHolder(dataDir: string): Promise<LockHolder | null> {
  return readLockHolder(jobLockPath(dataDir));
}
