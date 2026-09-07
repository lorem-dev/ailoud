import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Fs } from '@ailoud/core';
import { writeJobState } from './state.js';
import type { JobState } from './state.js';

/**
 * ailoud's own entry module, resolved from this file rather than from
 * `process.argv`.
 *
 * `argv[1]` is whatever launched this process, which under the MCP server is
 * the same binary but under a test runner is not. Deriving it from
 * `import.meta.url` means the detached child is always the build that spawned
 * it -- never a different install that happens to be first on PATH.
 */
export function cliEntryPath(): string {
  return fileURLToPath(new URL('../bin/ailoud.js', import.meta.url));
}

export function buildDetachedArgs(commandArgs: readonly string[], jobId: string): string[] {
  return [cliEntryPath(), ...commandArgs, '--job', jobId];
}

/**
 * Starts the work in a process that outlives this one.
 *
 * `detached` plus `unref` is what lets an MCP server exit, or an agent's
 * session end, while an hour of transcription carries on -- which is the
 * whole reason this feature exists.
 *
 * `stdio: 'ignore'` is not a contradiction of the job log: the child is
 * ailoud, and it writes its own log file from inside. Nothing needs to
 * survive a pipe, so nothing is piped -- an inherited pipe with no reader is
 * a way to wedge the child on a full buffer after an hour of work.
 *
 * `run()` is deliberately not used: it waits for the child and buffers its
 * output, which is the opposite of what is wanted here.
 *
 * `job` is the record `createJob` just wrote, whose `pid` is *this*
 * process's -- the launcher's, which is about to return and exit. That is
 * not the process a poller should be watching: once this returns, `pid`
 * would name a process that is already gone while the job is still very
 * much running, and `withLiveness` (see store.ts) would read that as a
 * corpse and flip the job to `failed`, error message and all, under the
 * launcher's own feet -- including for the job's own child the instant it
 * loads itself back with `--job` and starts reporting from that falsely
 * `failed` initial state, since nothing between there and a terminal write
 * corrects `state` on its own. Rewritten here, immediately, to the child's
 * real pid before anything else can read the file: the whole reason
 * `--detach` exists is for the id it hands back to be trustworthy from the
 * moment it is printed, not eventually.
 */
export async function spawnDetachedJob(
  deps: { readonly fs: Fs; readonly jobsDir: string },
  commandArgs: readonly string[],
  job: JobState,
): Promise<void> {
  // An argument array, never a shell string. The paths in here came from
  // user input. AGENTS.md, Security Notes.
  const child = spawn(process.execPath, buildDetachedArgs(commandArgs, job.id), {
    detached: true,
    stdio: 'ignore',
    shell: false,
  });
  child.unref();
  if (child.pid !== undefined) {
    try {
      await writeJobState(deps.fs, deps.jobsDir, { ...job, pid: child.pid, error: null });
    } catch {
      // Best-effort, like every other write JobReporter makes: the child is
      // already running, detached, whether or not this correction lands.
      // Losing it costs a poller a stale pid and a phantom "failed" until
      // the job reaches finish() or fail() -- which now always clear
      // `error` on the way to a terminal state, see JobReporter's own
      // comment -- but it does not cost the transcription, and it must
      // never be confused with the spawn itself having failed.
    }
  }
}
