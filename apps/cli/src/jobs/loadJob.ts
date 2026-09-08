import { UsageError } from '@ailoud/core';
import type { CliContext } from '../wiring.js';
import { JobLog } from './log.js';
import { JobReporter } from './reporter.js';
import { readJobState, writeJobState } from './state.js';
import type { JobState } from './state.js';

/**
 * Loads the job named by `--job`, or undefined when the flag was not given.
 *
 * A missing id is a UsageError naming it rather than a silent no-op: the id
 * came from whatever process started this one (a detached `--detach` child,
 * or the MCP server), and a wrong or stale one means something upstream is
 * confused, not that this run should quietly report nowhere.
 *
 * Shared by every command that accepts `--job`, rather than written per
 * command: this pipeline was written twice before this (see
 * summarizeRun.ts's own doc comment) and the copies drifted, and the same
 * thing happened to the lock takeover in exclusiveLock.ts. A third copy of
 * this ~20-line helper would be exactly that mistake again.
 *
 * Claims the pid before building the reporter, writing this process's own
 * `process.pid` into the state file. `createJob` had to write *some* pid
 * before this process existed to claim it, and for `--detach` that was the
 * launcher's -- a process that exits the moment it has spawned this one, so
 * without a correction `withLiveness` (store.ts) reads the file as a corpse
 * and flips a job that is very much running to `failed`. `spawn.ts` already
 * rewrites the pid to the child's right after spawning it, best-effort, but
 * that write can fail, race, or simply not have landed yet by the time this
 * runs -- and correctness must not depend on it landing. Read this raw with
 * `readJobState` rather than through `getJob`'s `withLiveness`: this process
 * IS the job, so its own liveness is not in question the way a poller's read
 * of a stranger's pid is, and seeding the reporter's `initial` with a
 * liveness-corrected `state: 'failed'` would be wrong -- nothing after the
 * constructor rewrites `state` back to `'running'` on its own, so a
 * progress report would climb `percent` while the file kept insisting the
 * job had already died.
 *
 * The claim is idempotent: whichever of this write and spawn.ts's write
 * lands last, both store this same process's pid, so they cannot disagree.
 *
 * This also covers a future MCP-spawned worker for free, with no change
 * here or there: `--job` is only ever passed to the process actually doing
 * the work, never to the one that started it, so claiming the pid on load
 * is correct for any launcher, not just `--detach`.
 */
export async function loadJob(
  context: CliContext,
  id: string | undefined,
): Promise<{ readonly reporter: JobReporter; readonly log: JobLog } | undefined> {
  if (id === undefined) return undefined;
  const state = await readJobState(context.fs, context.paths.jobsDir, id);
  if (state === null) {
    throw new UsageError(`no such job "${id}".`);
  }
  const claimed: JobState = { ...state, pid: process.pid };
  await writeJobState(context.fs, context.paths.jobsDir, claimed);
  const log = new JobLog(claimed.log);
  const reporter = new JobReporter({
    fs: context.fs,
    jobsDir: context.paths.jobsDir,
    initial: claimed,
    log,
  });
  return { reporter, log };
}
