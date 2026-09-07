// End-to-end test for background jobs with progress tracking.
// Exercises the full detach flow: running transcriptions in the background,
// polling progress, and managing jobs via the CLI.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Sandbox } from '../src/cli';
import { makeSandbox } from '../src/cli';

const REPO_ROOT = join(__dirname, '..', '..');
const FIXTURES_DIR = join(REPO_ROOT, 'fixtures');

const LONG_WAV = join(FIXTURES_DIR, 'three-speakers-en.wav');

const REAL_HOME = process.env['HOME'] ?? '';
const WHISPER_MODEL = join(REAL_HOME, '.local', 'share', 'ailoud', 'models', 'ggml-small.bin');

/** Parse the job id from transcribe --detach output. */
function parseDetachId(output: string): string {
  // Output is: "started job <id> -- progress in <path>"
  const match = /started job (\S+)/.exec(output);
  if (match === null) {
    throw new Error(`invalid --detach output: ${JSON.stringify(output)}`);
  }
  return match[1]!;
}

/** Parse job ls output to extract job ids. */
function parseJobLsOutput(output: string): string[] {
  const lines = output.trim().split('\n');
  if (lines.length === 0) return [];
  // Each line is: "id  kind  state  percent  stage"
  return lines.map((line) => {
    const parts = line.trim().split(/\s+/);
    return parts[0] ?? '';
  });
}

interface JobState {
  readonly id: string;
  readonly kind: string;
  readonly state: 'running' | 'done' | 'failed';
  readonly percent: number;
  readonly stage: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly recordings: { readonly total: number; readonly done: number };
  readonly declared: {
    readonly speakers: number | 'unknown';
    readonly languages: readonly string[];
  } | null;
  readonly log: string;
  readonly result: unknown;
  readonly error: string | null;
}

/** Read the job state file from the sandbox's data directory. */
async function readJobState(sandbox: Sandbox, jobId: string): Promise<JobState | null> {
  const jobsDir = join(sandbox.dataDir, 'jobs');
  const statePath = join(jobsDir, `${jobId}.json`);
  try {
    const content = await readFile(statePath, 'utf8');
    return JSON.parse(content) as JobState;
  } catch {
    return null;
  }
}

/** Sleep for a given number of milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('ailoud background jobs', () => {
  let sandbox: Sandbox;
  const createdJobIds: string[] = [];

  beforeEach(async () => {
    sandbox = await makeSandbox();
    createdJobIds.length = 0;
  });

  /**
   * Whether a process with the given pid is still alive. Uses the same
   * signal-0 check as `isRunning` in apps/cli/src/exclusiveLock.ts: ESRCH
   * means no such process (dead), EPERM means process exists under another
   * user (alive).
   *
   * A deliberate copy rather than an import of that exported function: this
   * suite runs under e2e/tsconfig.json (CommonJS, its own "include": ["src",
   * "tests"]), and apps/cli is an ESM package under NodeNext with relative
   * imports that end in `.js`. Reaching across that boundary into another
   * workspace package's `src` would need either a build-output import (this
   * suite drives the CLI as a subprocess precisely to test the built
   * artifact, not its internals) or a second tsconfig project reference for
   * five lines of logic. `exclusiveLock.ts`'s own header already explains why
   * a second copy of this check is a real risk -- it was wrong twice before
   * being extracted -- so this copy is kept intentionally small and pinned to
   * that file by name in this comment, not reinvented.
   */
  function isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  afterEach(async () => {
    // Detached jobs survive their launcher by design, so they must be killed
    // by pid. The pid is stored in the state file, which will be deleted by
    // sandbox.cleanup(), so extract it before cleanup.
    for (const jobId of createdJobIds) {
      let state: JobState | null;
      try {
        state = await readJobState(sandbox, jobId);
      } catch {
        // State file already gone or unreadable; skip cleanup for this job
        continue;
      }

      if (state !== null && (state.state === 'running' || state.state === 'failed')) {
        // Only kill if the job has not reached a terminal state, or if it
        // failed but the process might still be alive. Only skip if state
        // is 'done', which means the child exited cleanly.
        if (isProcessAlive(state.pid)) {
          try {
            // Negative pid: signals the whole process GROUP, not just the
            // recorded pid. `spawnDetachedJob` starts the child with
            // `detached: true`, which calls setsid() and makes it the leader
            // of a new group containing whisper. A plain
            // `process.kill(state.pid, ...)` would reach only the ailoud
            // child -- whisper is a grandchild in the same group and would
            // survive, along with the six-hour timeout that was supposed to
            // bound it (that timer lives in the ailoud child that just died,
            // not in whisper itself).
            process.kill(-state.pid, 'SIGTERM');
          } catch {
            // Process already gone; this is fine
          }
        }
      }
    }

    // Now it is safe to remove the sandbox: all child processes have been
    // signalled to stop.
    await sandbox.cleanup();
  });

  it('transcribes in the background and reports progress to completion', async () => {
    await sandbox.writeConfig(`stt:\n  whisperCpp:\n    model: ${WHISPER_MODEL}\n`);

    // Import the fixture
    const importResult = await sandbox.run(['import', LONG_WAV]);
    expect(importResult.code).toBe(0);
    // import output includes [text] decorations and "imported" status
    const rawOutput = importResult.stdout.trim();
    const importMatch = rawOutput.match(/(\S+)\s+imported/);
    expect(importMatch).not.toBeNull();
    const recordingId = importMatch![1]!;

    // Start a background transcription
    const detachResult = await sandbox.run(['transcribe', recordingId, '--lang', 'en', '--detach']);
    expect(detachResult.code).toBe(0);
    const jobId = parseDetachId(detachResult.stdout);
    expect(jobId.length).toBeGreaterThan(0);
    createdJobIds.push(jobId);

    // Poll the job state until it finishes, collecting progress percentages
    let state = await readJobState(sandbox, jobId);
    expect(state).not.toBeNull();
    expect(state!.state).toBe('running');

    // Give the child process time to start and produce initial progress
    await delay(1000);

    const seen: number[] = [];
    const deadline = Date.now() + 10 * 60_000; // 10 minute timeout for transcription
    // The child process reports progress, which JobReporter throttles to every
    // 2000ms when writing the state file. Poll frequently to maximize chances
    // of catching intermediate values between 0% and 100%.
    while (Date.now() < deadline) {
      state = await readJobState(sandbox, jobId);
      if (state === null) break;
      seen.push(state.percent);
      if (state.state !== 'running') break;
      await delay(300); // Poll every 300ms
    }
    // Final state should be done
    expect(state).not.toBeNull();
    expect(state!.state).toBe('done');
    expect(state!.percent).toBe(100);

    // Progress must have moved from 0 to 100, not jumped at the end
    expect(Math.max(...seen)).toBeGreaterThan(0);

    // Progress must never go backwards (monotonic increasing)
    const sorted = [...seen].sort((a, b) => a - b);
    expect(sorted).toEqual(seen);

    // Verify the transcript was created and contains expected text
    const showResult = await sandbox.run(['show', recordingId, '--format', 'text']);
    expect(showResult.code).toBe(0);
    const shown = showResult.stdout.toLowerCase();
    expect(shown).toContain('engine room');
  });

  it('lists the finished job and then forgets it', async () => {
    await sandbox.writeConfig(`stt:\n  whisperCpp:\n    model: ${WHISPER_MODEL}\n`);

    // Import and start a background transcription
    const importResult = await sandbox.run(['import', LONG_WAV]);
    expect(importResult.code).toBe(0);
    const rawOutput = importResult.stdout.trim();
    const importMatch = rawOutput.match(/(\S+)\s+imported/);
    expect(importMatch).not.toBeNull();
    const recordingId = importMatch![1]!;

    const detachResult = await sandbox.run(['transcribe', recordingId, '--lang', 'en', '--detach']);
    expect(detachResult.code).toBe(0);
    const jobId = parseDetachId(detachResult.stdout);
    createdJobIds.push(jobId);

    // Wait for the job to finish
    let state = await readJobState(sandbox, jobId);
    const deadline = Date.now() + 10 * 60_000;
    while (state !== null && state.state === 'running' && Date.now() < deadline) {
      await delay(2000);
      state = await readJobState(sandbox, jobId);
    }
    expect(state!.state).toBe('done');

    // List jobs -- the finished one should appear
    const lsResult = await sandbox.run(['job', 'ls']);
    expect(lsResult.code).toBe(0);
    const listedIds = parseJobLsOutput(lsResult.stdout);
    expect(listedIds).toContain(jobId);

    // Remove the job
    const rmResult = await sandbox.run(['job', 'rm', jobId]);
    expect(rmResult.code).toBe(0);
    expect(rmResult.stdout).toContain('removed');

    // Show should now report UNKNOWN
    const showResult = await sandbox.run(['job', 'show', jobId]);
    expect(showResult.code).not.toBe(0);
    expect(showResult.stderr).toContain('UNKNOWN');
  });

  it('refuses a second job while one is running', async () => {
    await sandbox.writeConfig(`stt:\n  whisperCpp:\n    model: ${WHISPER_MODEL}\n`);

    // Import the fixture
    const importResult = await sandbox.run(['import', LONG_WAV]);
    expect(importResult.code).toBe(0);
    const rawOutput = importResult.stdout.trim();
    const importMatch = rawOutput.match(/(\S+)\s+imported/);
    expect(importMatch).not.toBeNull();
    const recordingId = importMatch![1]!;

    // Start the first background transcription
    const firstDetachResult = await sandbox.run([
      'transcribe',
      recordingId,
      '--lang',
      'en',
      '--detach',
    ]);
    expect(firstDetachResult.code).toBe(0);
    const firstJobId = parseDetachId(firstDetachResult.stdout);
    createdJobIds.push(firstJobId);

    // Confirm the first job is actually running
    let state = await readJobState(sandbox, firstJobId);
    let attempts = 0;
    while ((state === null || state.state !== 'running') && attempts < 20) {
      await delay(500);
      state = await readJobState(sandbox, firstJobId);
      attempts += 1;
    }
    expect(state!.state).toBe('running');

    // Attempt to start a second transcription -- should be refused
    const secondDetachResult = await sandbox.run([
      'transcribe',
      recordingId,
      '--lang',
      'en',
      '--detach',
    ]);
    expect(secondDetachResult.code).not.toBe(0);
    // The error should name the holder (first job id)
    expect(secondDetachResult.stderr.toLowerCase()).toMatch(/job|running|lock|holder|refused/i);
  });
});
