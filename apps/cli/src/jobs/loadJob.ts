import { UsageError } from '@ailoud/core';
import type { CliContext } from '../wiring.js';
import { JobLog } from './log.js';
import { JobReporter } from './reporter.js';
import { getJob } from './store.js';

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
 */
export async function loadJob(
  context: CliContext,
  id: string | undefined,
): Promise<{ readonly reporter: JobReporter; readonly log: JobLog } | undefined> {
  if (id === undefined) return undefined;
  const state = await getJob(context.fs, context.paths.jobsDir, id);
  if (state === null) {
    throw new UsageError(`no such job "${id}".`);
  }
  const log = new JobLog(state.log);
  const reporter = new JobReporter({
    fs: context.fs,
    jobsDir: context.paths.jobsDir,
    initial: state,
    log,
  });
  return { reporter, log };
}
