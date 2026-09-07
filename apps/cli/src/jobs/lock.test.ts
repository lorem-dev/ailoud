import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jobLockHolder, jobLockPath, withJobLock } from './lock.js';

describe('withJobLock', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ailoud-jobs-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs the body and releases the lock', async () => {
    await expect(withJobLock(dir, async () => 'done')).resolves.toBe('done');
    await expect(jobLockHolder(dir)).resolves.toBeNull();
  });

  it('refuses a second run while the first holds it, naming the holder', async () => {
    await withJobLock(dir, async () => {
      await expect(withJobLock(dir, async () => 'second')).rejects.toThrow(
        /another ailoud job is already running/,
      );
    });
  });

  it('reports the holder while the body runs', async () => {
    await withJobLock(dir, async () => {
      const holder = await jobLockHolder(dir);
      expect(holder?.pid).toBe(process.pid);
    });
  });

  it('releases the lock even when the body throws', async () => {
    await expect(withJobLock(dir, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(jobLockHolder(dir)).resolves.toBeNull();
  });

  it('keeps its lock file separate from provisioning', () => {
    expect(jobLockPath(dir)).toContain('jobs.lock');
  });
});
