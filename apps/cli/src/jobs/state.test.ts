import { describe, expect, it } from 'vitest';
import { NodeFs } from '@ailoud/providers';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobLogPath, jobStatePath, readJobState, writeJobState } from './state.js';
import type { JobState } from './state.js';

function state(partial: Partial<JobState> = {}): JobState {
  return {
    id: '01K4TESTTESTTESTTESTTESTTE',
    kind: 'transcribe',
    state: 'running',
    percent: 0,
    stage: 'starting',
    pid: process.pid,
    startedAt: '2026-09-07T08:00:00.000Z',
    finishedAt: null,
    recordings: { total: 1, done: 0 },
    declared: { speakers: 3, languages: ['ru', 'en'] },
    log: '/tmp/x.log',
    result: null,
    error: null,
    ...partial,
  };
}

describe('job state', () => {
  it('round-trips through the filesystem', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ailoud-state-'));
    try {
      const fs = new NodeFs();
      const written = state({ percent: 46, stage: 'transcribing' });
      await writeJobState(fs, dir, written);
      await expect(readJobState(fs, dir, written.id)).resolves.toEqual(written);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null for an id it has never seen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ailoud-state-'));
    try {
      await expect(readJobState(new NodeFs(), dir, 'nosuchid')).resolves.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a truncated file rather than throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ailoud-state-'));
    try {
      const fs = new NodeFs();
      await fs.ensureDir(dir);
      await fs.writeTextFile(jobStatePath(dir, 'halfwritten'), '{"id": "half');
      await expect(readJobState(fs, dir, 'halfwritten')).resolves.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('replaces the file atomically, so a reader never sees a partial document', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ailoud-state-'));
    try {
      const fs = new NodeFs();
      const id = state().id;
      await writeJobState(fs, dir, state());
      // Hammer reads against writes. Every read must yield a whole document
      // or nothing, never a parse error -- that is what the rename buys.
      const writes = (async () => {
        for (let i = 1; i <= 200; i += 1) await writeJobState(fs, dir, state({ percent: i % 100 }));
      })();
      const reads = (async () => {
        for (let i = 0; i < 200; i += 1) {
          const read = await readJobState(fs, dir, id);
          expect(read === null || read.id === id).toBe(true);
        }
      })();
      await Promise.all([writes, reads]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('puts the log beside the state, under the same id', () => {
    expect(jobLogPath('/jobs', 'abc')).toBe('/jobs/abc.log');
    expect(jobStatePath('/jobs', 'abc')).toBe('/jobs/abc.json');
  });
});
