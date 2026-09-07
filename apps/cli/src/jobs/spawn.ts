import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Fs } from '@ailoud/core';
import { readJobState, writeJobState } from './state.js';
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
 * Best-effort: overwrites only `pid` on whatever the job's state file
 * actually holds at the moment this runs, not on the `job` snapshot
 * `createJob` handed back.
 *
 * That snapshot is stale by construction -- it is a picture of `percent: 0,
 * stage: 'starting'` from before the child had done anything. The child
 * claims its own pid on load too (see loadJob.ts) and starts reporting real
 * progress immediately; if that lands before this correction does, spreading
 * the stale `job` over the current file (`{ ...job, pid }`) would silently
 * walk `percent` and `stage` back to zero under real progress already
 * written. Reading the current state first and touching only the field this
 * correction is actually about avoids that regression entirely, whichever of
 * the two writers landed last.
 *
 * Does NOT touch `error`. An earlier version also wrote `error: null` here,
 * on the theory that a stale pid could make `withLiveness` misreport a live
 * job as failed. That is true, but clearing `error` unconditionally would
 * just as readily erase a genuine failure the child had already written
 * before this correction lands -- `finish()` and `fail()` already clear
 * `error` on their own way to a terminal state (see JobReporter), which is
 * the right place for that, not a pid correction that runs at most once,
 * best-effort, right after spawn.
 */
async function correctPid(
  deps: { readonly fs: Fs; readonly jobsDir: string },
  job: JobState,
  pid: number,
): Promise<void> {
  try {
    const current = (await readJobState(deps.fs, deps.jobsDir, job.id)) ?? job;
    await writeJobState(deps.fs, deps.jobsDir, { ...current, pid });
  } catch {
    // Best-effort, like every other write JobReporter makes: the child is
    // already running, detached, whether or not this correction lands.
    // Losing it costs a poller a stale pid and, transiently, a possible
    // "failed" from withLiveness reading it -- but it does not cost the
    // transcription, and it must never be confused with the spawn itself
    // having failed.
  }
}

/**
 * Best-effort: marks the job failed when the child never actually started.
 *
 * Same read-modify-write shape as correctPid, and the same reason: this
 * fires from the 'error' handler below, which can race the child's own
 * writes in principle, so it must not clobber real state with a stale
 * snapshot either -- though in practice a child that never started has
 * written nothing yet.
 */
async function markSpawnFailed(
  deps: { readonly fs: Fs; readonly jobsDir: string },
  job: JobState,
  message: string,
): Promise<void> {
  try {
    const current = (await readJobState(deps.fs, deps.jobsDir, job.id)) ?? job;
    await writeJobState(deps.fs, deps.jobsDir, {
      ...current,
      state: 'failed',
      finishedAt: new Date().toISOString(),
      error: message,
    });
  } catch {
    // The id this job was handed out under must always resolve, but a
    // write that fails here does not get to escape and take the launcher
    // down a second time -- see the 'error' handler's own comment.
  }
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
 * No timeout, unlike every other subprocess this project spawns (run.ts's
 * `DEFAULT_TIMEOUT_MS`), and `runInteractive` is not the only other
 * exception: this is the second. A detached job outlives its launcher by
 * definition, so the launcher cannot hold a timer for it -- it is about to
 * exit -- and inventing one it cannot enforce would be worse than none. The
 * work inside the child is bounded anyway: whisper itself is spawned through
 * `run()` with its own six-hour timeout (whisperCpp.ts). What a timeout here
 * could catch that nothing else does is the child wedging on something
 * outside a subprocess call entirely, and `withLiveness` (store.ts) cannot
 * see that either -- it detects a dead pid, not a hung one.
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
  // Attached synchronously, right after spawn(): an asynchronous spawn
  // failure -- EMFILE, a permissions problem, resource exhaustion, anything
  // that is not a synchronous throw -- arrives as an 'error' event on the
  // child, and with no listener Node turns that into an uncaught exception.
  // That exception surfaces after this function has already returned and
  // the launcher has already printed the job id, so without this the
  // launcher would die with a stack trace instead of exiting cleanly. Marks
  // the job failed instead, best-effort, and never rethrows -- an id handed
  // out must always resolve. Same class of failure, same fix, as run.ts's
  // 'error' handler.
  child.on('error', (error) => {
    void markSpawnFailed(deps, job, error instanceof Error ? error.message : String(error));
  });
  child.unref();
  if (child.pid !== undefined) {
    await correctPid(deps, job, child.pid);
  }
}
