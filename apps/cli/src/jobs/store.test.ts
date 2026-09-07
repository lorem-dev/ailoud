import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeFs } from '@ailoud/providers';
import { createJob, getJob, listJobs, pruneJobs, removeJob, withLiveness } from './store.js';
import { writeJobState } from './state.js';
import type { JobState } from './state.js';

const CLOCK = { nowIso: () => '2026-09-07T08:00:00.000Z' };

function ids(...values: string[]) {
  let i = 0;
  return { next: () => values[i++] ?? `extra-${i}` };
}

function state(partial: Partial<JobState>): JobState {
  return {
    id: 'j1',
    kind: 'transcribe',
    state: 'done',
    percent: 100,
    stage: 'done',
    pid: process.pid,
    startedAt: '2026-09-07T08:00:00.000Z',
    finishedAt: '2026-09-07T09:00:00.000Z',
    recordings: { total: 1, done: 1 },
    declared: null,
    log: '/tmp/j1.log',
    result: null,
    error: null,
    ...partial,
  };
}

async function withDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ailoud-store-'));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('createJob', () => {
  it('writes a running job the caller can read back immediately', async () => {
    await withDir(async (dir) => {
      const fs = new NodeFs();
      const job = await createJob(
        { fs, ids: ids('01K4A'), clock: CLOCK, jobsDir: dir },
        { kind: 'transcribe', recordings: 3, declared: { speakers: 4, languages: ['ru', 'en'] } },
      );
      expect(job.state).toBe('running');
      expect(job.percent).toBe(0);
      expect(job.recordings).toEqual({ total: 3, done: 0 });
      // The whole point: the id is resolvable the instant it is handed out.
      await expect(getJob(fs, dir, job.id)).resolves.toMatchObject({ id: job.id });
    });
  });
});

describe('withLiveness', () => {
  it('leaves a finished job alone', () => {
    expect(withLiveness(state({ state: 'done' })).state).toBe('done');
  });

  it('leaves a running job with a live pid alone', () => {
    expect(withLiveness(state({ state: 'running', pid: process.pid })).state).toBe('running');
  });

  it('turns a running job with a dead pid into a failure', () => {
    // Pid 1 is alive, so a fake high pid is used. A running job whose
    // process is gone must not be polled for an hour as though it were live.
    const dead = withLiveness(state({ state: 'running', pid: 2_147_483_600 }));
    expect(dead.state).toBe('failed');
    expect(dead.error).toContain('no longer running');
  });
});

describe('listJobs', () => {
  it('returns newest first', async () => {
    await withDir(async (dir) => {
      const fs = new NodeFs();
      await writeJobState(fs, dir, state({ id: '01A' }));
      await writeJobState(fs, dir, state({ id: '01C' }));
      await writeJobState(fs, dir, state({ id: '01B' }));
      const listed = await listJobs(fs, dir);
      expect(listed.map((job) => job.id)).toEqual(['01C', '01B', '01A']);
    });
  });

  it('is empty rather than throwing when the directory has never existed', async () => {
    await withDir(async (dir) => {
      await expect(listJobs(new NodeFs(), join(dir, 'nope'))).resolves.toEqual([]);
    });
  });

  it('skips a file that is not a job state document', async () => {
    await withDir(async (dir) => {
      const fs = new NodeFs();
      await writeJobState(fs, dir, state({ id: '01A' }));
      await fs.writeTextFile(join(dir, '01A.log'), 'not json');
      await fs.writeTextFile(join(dir, 'junk.json'), '{ broken');
      expect((await listJobs(fs, dir)).map((job) => job.id)).toEqual(['01A']);
    });
  });

  it('ignores a scratch file left behind by a write that crashed mid-rename', async () => {
    await withDir(async (dir) => {
      const fs = new NodeFs();
      await writeJobState(fs, dir, state({ id: '01A' }));
      // writeJobState's own scratch-path shape: <id>.json.<uuid>.writing.
      // It contains ".json" but does not end in it, so a naive substring
      // filter would try to parse this as a job state document.
      await fs.writeTextFile(
        join(dir, '01B.json.9b1f1c1e-0000-4000-8000-000000000000.writing'),
        `${JSON.stringify(state({ id: '01B' }))}\n`,
      );
      expect((await listJobs(fs, dir)).map((job) => job.id)).toEqual(['01A']);
    });
  });
});

describe('pruneJobs', () => {
  it('keeps the newest finished jobs and drops the rest, with their logs', async () => {
    await withDir(async (dir) => {
      const fs = new NodeFs();
      for (const id of ['01A', '01B', '01C', '01D']) {
        await writeJobState(fs, dir, state({ id }));
        await fs.writeTextFile(join(dir, `${id}.log`), 'x');
      }
      await pruneJobs(fs, dir, 2);
      expect((await listJobs(fs, dir)).map((job) => job.id)).toEqual(['01D', '01C']);
      await expect(fs.exists(join(dir, '01A.log'))).resolves.toBe(false);
    });
  });

  it('never prunes a running job, however old', async () => {
    await withDir(async (dir) => {
      const fs = new NodeFs();
      await writeJobState(fs, dir, state({ id: '01A', state: 'running', pid: process.pid }));
      await writeJobState(fs, dir, state({ id: '01B' }));
      await writeJobState(fs, dir, state({ id: '01C' }));
      await pruneJobs(fs, dir, 1);
      expect((await listJobs(fs, dir)).map((job) => job.id)).toContain('01A');
    });
  });
});

describe('removeJob', () => {
  it('removes the state and the log, and reports that it did', async () => {
    await withDir(async (dir) => {
      const fs = new NodeFs();
      await writeJobState(fs, dir, state({ id: '01A' }));
      await fs.writeTextFile(join(dir, '01A.log'), 'x');
      await expect(removeJob(fs, dir, '01A')).resolves.toBe(true);
      await expect(fs.exists(join(dir, '01A.json'))).resolves.toBe(false);
      await expect(fs.exists(join(dir, '01A.log'))).resolves.toBe(false);
    });
  });

  it('reports false for an id it never had', async () => {
    await withDir(async (dir) => {
      await expect(removeJob(new NodeFs(), dir, 'nope')).resolves.toBe(false);
    });
  });
});
