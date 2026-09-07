import { join } from 'node:path';
import { withExclusiveLock } from './exclusiveLock.js';

export function lockPath(dataDir: string): string {
  return join(dataDir, 'provisioning.lock');
}

/**
 * Takes an exclusive lock for the duration of `body`.
 *
 * Provisioning downloads into shared scratch paths under the data
 * directory, so two runs at once can delete or truncate a file the other is
 * streaming. Before this, that produced a confusing failure rather than a
 * clean refusal.
 *
 * Provisioning is interactive and can sit on a consent prompt for minutes,
 * so a queued second run would look like a hang.
 */
export function withProvisioningLock<T>(dataDir: string, body: () => Promise<T>): Promise<T> {
  return withExclusiveLock(
    lockPath(dataDir),
    {
      busy: (holder) =>
        `another ailoud provisioning run is already in progress (pid ${holder.pid}, started ` +
        `${holder.startedAt}). Wait for it to finish, or stop it, then try again.`,
      stealing: 'another ailoud provisioning run is taking over a stale lock right now. Try again.',
      raced: 'another ailoud provisioning run took the lock at the same moment. Try again.',
    },
    body,
  );
}
