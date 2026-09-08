import { describe, expect, it } from 'vitest';
import { context } from '../commands/testContext.js';
import { loadJob } from './loadJob.js';
import { readJobState, writeJobState } from './state.js';
import type { JobState } from './state.js';

function jobState(partial: Partial<JobState> = {}): JobState {
  return {
    id: '01LOADJOBTESTTESTTESTTESTTE',
    kind: 'transcribe',
    state: 'running',
    percent: 40,
    stage: 'transcribing',
    // A pid nothing alive holds, distinct from this test process's own --
    // stands in for the launcher's now-exited pid `createJob` wrote before
    // this process existed to claim it.
    pid: 2_147_483_600,
    startedAt: '2026-09-07T08:00:00.000Z',
    finishedAt: null,
    recordings: { total: 1, done: 0 },
    declared: null,
    log: '/d/jobs/01LOADJOBTESTTESTTESTTESTTE.log',
    result: null,
    error: null,
    ...partial,
  };
}

describe('loadJob', () => {
  it('returns undefined when --job was not given', async () => {
    const ctx = context();
    await expect(loadJob(ctx, undefined)).resolves.toBeUndefined();
  });

  it('throws a UsageError naming an id with no such job', async () => {
    const ctx = context();
    await expect(loadJob(ctx, 'nope')).rejects.toThrow(/no such job "nope"/);
  });

  it("claims this process's pid in the state file, overwriting the launcher's", async () => {
    const ctx = context();
    const seeded = jobState();
    await writeJobState(ctx.fs, ctx.paths.jobsDir, seeded);

    const loaded = await loadJob(ctx, seeded.id);

    expect(loaded).toBeDefined();
    const onDisk = await readJobState(ctx.fs, ctx.paths.jobsDir, seeded.id);
    expect(onDisk?.pid).toBe(process.pid);
    // The pre-claim pid was dead, so a liveness-corrected read (getJob's
    // withLiveness) of the seed would already read "failed". The claim runs
    // before the reporter is built specifically so the reporter's own
    // `initial` -- and so the file, once report()/finish() write again --
    // never carries that phantom failure. See loadJob's own comment.
    expect(onDisk?.state).toBe('running');
    expect(onDisk?.error).toBeNull();
  });

  it('leaves every other field untouched', async () => {
    const ctx = context();
    const seeded = jobState();
    await writeJobState(ctx.fs, ctx.paths.jobsDir, seeded);

    await loadJob(ctx, seeded.id);

    const onDisk = await readJobState(ctx.fs, ctx.paths.jobsDir, seeded.id);
    expect(onDisk).toEqual({ ...seeded, pid: process.pid });
  });

  it('is idempotent when this process already owns the pid', async () => {
    const ctx = context();
    const seeded = jobState({ pid: process.pid });
    await writeJobState(ctx.fs, ctx.paths.jobsDir, seeded);

    await loadJob(ctx, seeded.id);

    const onDisk = await readJobState(ctx.fs, ctx.paths.jobsDir, seeded.id);
    expect(onDisk).toEqual(seeded);
  });
});
