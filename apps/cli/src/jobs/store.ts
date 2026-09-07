import { basename } from 'node:path';
import type { Clock, Fs, Ids } from '@ailoud/core';
import { jobLogPath, jobStatePath, readJobState, writeJobState } from './state.js';
import type { JobKind, JobState } from './state.js';

/**
 * Whether the process that owns a job is still running.
 *
 * The same signal-0 check `exclusiveLock.ts` uses, with the same two-error
 * subtlety: ESRCH means no such process, so the job died; EPERM means the
 * process EXISTS under another user, which is alive. Getting that backwards
 * would report a live hour-long transcription as dead.
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
 * Corrects `running` to `failed` when the owning process is gone.
 *
 * A detached job outlives the server that started it, which is the point --
 * but it means `state: "running"` in the file is a claim, not a fact. Without
 * this, a job killed by a reboot or an OOM reads as "still working" forever
 * and an agent polls a corpse.
 *
 * Applied on read rather than written into the file: the process that would
 * have to write it is the one that died.
 */
export function withLiveness(state: JobState): JobState {
  if (state.state !== 'running') return state;
  if (isRunning(state.pid)) return state;
  return {
    ...state,
    state: 'failed',
    error:
      state.error ??
      `the job's process (pid ${state.pid}) is no longer running; see ${state.log} for what it managed to do`,
  };
}

/**
 * Starts a job: writes its state file and hands back the state, running.
 *
 * The write is awaited rather than fired and forgotten. The whole contract
 * of the id this returns is that a caller can hand it straight to an agent
 * and the agent can resolve it immediately -- a race between "return the id"
 * and "the file exists" would make that contract a coin flip.
 */
export async function createJob(
  deps: { fs: Fs; ids: Ids; clock: Clock; jobsDir: string },
  input: { kind: JobKind; recordings: number; declared: JobState['declared'] },
): Promise<JobState> {
  const { fs, ids, clock, jobsDir } = deps;
  const id = ids.next();
  const state: JobState = {
    id,
    kind: input.kind,
    state: 'running',
    percent: 0,
    stage: 'starting',
    pid: process.pid,
    startedAt: clock.nowIso(),
    finishedAt: null,
    recordings: { total: input.recordings, done: 0 },
    declared: input.declared,
    log: jobLogPath(jobsDir, id),
    result: null,
    error: null,
  };
  await writeJobState(fs, jobsDir, state);
  return state;
}

/**
 * Every job, newest first, with liveness corrected.
 *
 * Only entries ending in `.json` are treated as job state documents.
 * `writeJobState` writes through a scratch path of the form
 * `<id>.json.<uuid>.writing` before renaming it over the target, and a crash
 * between those two steps leaves that scratch file behind with nothing to
 * clean it up. `.json` merely appearing in the name is not enough -- every
 * one of those scratch files contains it too -- so this checks the name
 * ends there.
 *
 * An absent directory (no job has ever been created) yields `[]` rather than
 * an ENOENT from `fs.listFiles`.
 *
 * Sorted by id, descending, rather than by a timestamp field: ids are ULIDs,
 * which sort lexically by creation time, so the id itself is the sort key.
 */
export async function listJobs(fs: Fs, jobsDir: string): Promise<JobState[]> {
  if (!(await fs.exists(jobsDir))) return [];
  const ids = (await fs.listFiles(jobsDir))
    .filter((path) => path.endsWith('.json'))
    .map((path) => basename(path, '.json'));
  const jobs: JobState[] = [];
  for (const id of ids) {
    const state = await readJobState(fs, jobsDir, id);
    // Null covers a file that vanished, or failed to parse, between the
    // directory listing above and the read -- see readJobState's own
    // comment. Either way there is nothing to report for it.
    if (state !== null) jobs.push(withLiveness(state));
  }
  return jobs.sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0));
}

/** One job by id, with liveness corrected, or null if there is no such job. */
export async function getJob(fs: Fs, jobsDir: string, id: string): Promise<JobState | null> {
  const state = await readJobState(fs, jobsDir, id);
  return state === null ? null : withLiveness(state);
}

/**
 * Deletes the oldest finished jobs, keeping the `keep` newest plus every
 * running job regardless of age.
 *
 * A running job is never pruned, however old: its state file is the only
 * record of a process that may still be working, and `withLiveness` (applied
 * by `listJobs`, which this reads from) is what tells a genuinely dead one
 * from a live one -- so by the time a job reaches this filter as "running",
 * it already survived that check.
 */
export async function pruneJobs(fs: Fs, jobsDir: string, keep: number): Promise<void> {
  const jobs = await listJobs(fs, jobsDir); // newest first
  const finished = jobs.filter((job) => job.state !== 'running');
  const toRemove = finished.slice(keep);
  for (const job of toRemove) await removeJob(fs, jobsDir, job.id);
}

/**
 * Removes a job's state file and its log.
 *
 * `fs.removeFile` treats an absent file as success, so this cannot fail on
 * a job with no log yet -- there is a window between `createJob` and the
 * first `JobLog.append` where the log file does not exist at all. The
 * return value reports whether the state file existed beforehand, so a
 * caller can tell "removed" from "there was never such a job".
 */
export async function removeJob(fs: Fs, jobsDir: string, id: string): Promise<boolean> {
  const statePath = jobStatePath(jobsDir, id);
  const existed = await fs.exists(statePath);
  await fs.removeFile(statePath);
  await fs.removeFile(jobLogPath(jobsDir, id));
  return existed;
}
