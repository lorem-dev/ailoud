import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemFs } from '@ailoud/core/testing';
import { buildDetachedArgs, cliEntryPath, spawnDetachedJob } from './spawn.js';
import { readJobState, writeJobState } from './state.js';
import type { JobState } from './state.js';

describe('cliEntryPath', () => {
  it('points at a javascript file that exists in the built tree', () => {
    expect(cliEntryPath()).toMatch(/\.js$/);
  });
});

describe('buildDetachedArgs', () => {
  it('puts the entry first and the job id last', () => {
    const args = buildDetachedArgs(['audio', 'transcribe', 'REC1', '--lang', 'ru'], 'JOB1');
    expect(args[0]).toBe(cliEntryPath());
    expect(args.slice(-2)).toEqual(['--job', 'JOB1']);
  });

  it('passes every argument through as its own array element', () => {
    // Never a shell string: paths reaching here come from user input, and a
    // shell would interpret them. AGENTS.md, Security Notes.
    const args = buildDetachedArgs(['audio', 'transcribe', '/in/a b; rm -rf x.wav'], 'JOB1');
    expect(args).toContain('/in/a b; rm -rf x.wav');
  });
});

// child_process.spawn is swapped for a fake that never touches a real
// process: this suite is about the pid rewrite around it, not about
// whether `node` itself can be launched in CI.
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

function fakeChild(
  pid: number | undefined,
): EventEmitter & { pid: number | undefined; unref: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as EventEmitter & {
    pid: number | undefined;
    unref: ReturnType<typeof vi.fn>;
  };
  child.pid = pid;
  child.unref = vi.fn();
  return child;
}

function job(partial: Partial<JobState> = {}): JobState {
  return {
    id: '01SPAWNTESTTESTTESTTESTTESTT',
    kind: 'transcribe',
    state: 'running',
    percent: 0,
    stage: 'starting',
    pid: process.pid, // the launcher's own pid, as createJob writes it
    startedAt: '2026-09-07T08:00:00.000Z',
    finishedAt: null,
    recordings: { total: 1, done: 0 },
    declared: null,
    log: '/d/jobs/01SPAWNTESTTESTTESTTESTTESTT.log',
    result: null,
    error: null,
    ...partial,
  };
}

describe('spawnDetachedJob', () => {
  afterEach(async () => {
    const { spawn } = await import('node:child_process');
    vi.mocked(spawn).mockReset();
  });

  it("rewrites the job's pid to the child's, not the launcher's", async () => {
    const { spawn } = await import('node:child_process');
    vi.mocked(spawn).mockReturnValue(fakeChild(4242) as unknown as ReturnType<typeof spawn>);
    const fs = new MemFs();
    const jobsDir = '/d/jobs';
    const initial = job();
    await writeJobState(fs, jobsDir, initial);

    await spawnDetachedJob({ fs, jobsDir }, ['transcribe'], initial);

    const state = await readJobState(fs, jobsDir, initial.id);
    expect(state?.pid).toBe(4242);
    // Everything else is carried through unchanged.
    expect(state).toEqual({ ...initial, pid: 4242 });
  });

  it('spawns an argument array, never a shell string', async () => {
    const { spawn } = await import('node:child_process');
    const mock = vi
      .mocked(spawn)
      .mockReturnValue(fakeChild(1) as unknown as ReturnType<typeof spawn>);
    const fs = new MemFs();
    const jobsDir = '/d/jobs';
    const initial = job();
    await writeJobState(fs, jobsDir, initial);

    await spawnDetachedJob({ fs, jobsDir }, ['transcribe', 'REC1'], initial);

    expect(mock).toHaveBeenCalledTimes(1);
    const [command, args, options] = mock.mock.calls[0]!;
    expect(command).toBe(process.execPath);
    expect(Array.isArray(args)).toBe(true);
    expect(options).toMatchObject({ detached: true, stdio: 'ignore', shell: false });
  });

  it('leaves the state alone when the child never got a pid', async () => {
    const { spawn } = await import('node:child_process');
    vi.mocked(spawn).mockReturnValue(fakeChild(undefined) as unknown as ReturnType<typeof spawn>);
    const fs = new MemFs();
    const jobsDir = '/d/jobs';
    const initial = job();
    await writeJobState(fs, jobsDir, initial);

    await spawnDetachedJob({ fs, jobsDir }, ['transcribe'], initial);

    const state = await readJobState(fs, jobsDir, initial.id);
    expect(state).toEqual(initial);
  });

  it("does not walk percent and stage back to zero when the child's own progress lands first", async () => {
    // The `job` snapshot spawnDetachedJob is called with is stale the moment
    // it is created -- percent: 0, stage: 'starting'. If the child's own pid
    // claim and its first report() land on disk before this correction runs,
    // a naive `{ ...job, pid, error: null }` write would spread that stale
    // snapshot back over real progress. The correction must touch only pid
    // and error.
    const { spawn } = await import('node:child_process');
    vi.mocked(spawn).mockReturnValue(fakeChild(4242) as unknown as ReturnType<typeof spawn>);
    const fs = new MemFs();
    const jobsDir = '/d/jobs';
    const initial = job();
    // The child has already claimed its own pid and reported real progress
    // by the time the launcher's correction gets a chance to run.
    const advanced: JobState = { ...initial, pid: 4242, percent: 47, stage: 'transcribing' };
    await writeJobState(fs, jobsDir, advanced);

    await spawnDetachedJob({ fs, jobsDir }, ['transcribe'], initial);

    const state = await readJobState(fs, jobsDir, initial.id);
    expect(state).toEqual(advanced);
  });

  it('marks the job failed, without throwing, when spawn itself reports an error', async () => {
    // An asynchronous spawn failure (EMFILE, a permissions problem, resource
    // exhaustion) arrives as an 'error' event on the child, not as a thrown
    // exception -- and it can arrive after spawnDetachedJob has already
    // returned. A missing listener would take the launcher down with an
    // uncaught exception; this asserts spawnDetachedJob itself never throws
    // and that the failure is recorded on the job instead.
    const { spawn } = await import('node:child_process');
    const child = fakeChild(4242);
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const fs = new MemFs();
    const jobsDir = '/d/jobs';
    const initial = job();
    await writeJobState(fs, jobsDir, initial);

    await expect(
      spawnDetachedJob({ fs, jobsDir }, ['transcribe'], initial),
    ).resolves.toBeUndefined();

    const error = Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' });
    child.emit('error', error);

    await vi.waitFor(async () => {
      const state = await readJobState(fs, jobsDir, initial.id);
      expect(state?.state).toBe('failed');
    });

    const state = await readJobState(fs, jobsDir, initial.id);
    expect(state?.state).toBe('failed');
    expect(state?.error).toContain('EMFILE');
    expect(state?.finishedAt).not.toBeNull();
  });
});
