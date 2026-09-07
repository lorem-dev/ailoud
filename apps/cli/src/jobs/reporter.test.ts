import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeFs } from '@ailoud/providers';
import type { Fs, TempDir, TempFile } from '@ailoud/core';
import { JobLog } from './log.js';
import { JobReporter } from './reporter.js';
import { readJobState } from './state.js';
import type { JobState } from './state.js';

function initial(dir: string): JobState {
  return {
    id: '01K4TESTTESTTESTTESTTESTTE',
    kind: 'transcribe',
    state: 'running',
    percent: 0,
    stage: 'starting',
    pid: process.pid,
    startedAt: '2026-09-07T08:00:00.000Z',
    finishedAt: null,
    recordings: { total: 2, done: 0 },
    declared: { speakers: 3, languages: ['ru'] },
    log: join(dir, 'j.log'),
    result: null,
    error: null,
  };
}

async function withDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ailoud-rep-'));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Delegates every call to a real NodeFs and counts writeTextFile calls.
 *
 * The brief's own sketch built this by spreading a NodeFs instance
 * (`{ ...fs, writeTextFile: ... }`). That does not work: NodeFs's methods
 * live on its prototype, not as own enumerable properties, so a spread of an
 * instance copies nothing and the resulting object is missing exists,
 * ensureDir and the rest -- writeJobState calls fs.ensureDir first and
 * throws on the spread object. A small class implementing Fs and delegating
 * to a real NodeFs keeps every other method intact.
 */
class CountingFs implements Fs {
  public writes = 0;
  private readonly inner = new NodeFs();

  exists(path: string): Promise<boolean> {
    return this.inner.exists(path);
  }
  ensureDir(path: string): Promise<void> {
    return this.inner.ensureDir(path);
  }
  sha256(path: string): Promise<string> {
    return this.inner.sha256(path);
  }
  copyFile(source: string, destination: string): Promise<void> {
    return this.inner.copyFile(source, destination);
  }
  listFiles(directory: string): Promise<string[]> {
    return this.inner.listFiles(directory);
  }
  removeFile(path: string): Promise<void> {
    return this.inner.removeFile(path);
  }
  isDirectory(path: string): Promise<boolean> {
    return this.inner.isDirectory(path);
  }
  tempFile(extension: string): Promise<TempFile> {
    return this.inner.tempFile(extension);
  }
  tempDir(): Promise<TempDir> {
    return this.inner.tempDir();
  }
  async writeTextFile(path: string, content: string): Promise<void> {
    this.writes += 1;
    await this.inner.writeTextFile(path, content);
  }
  readTextFile(path: string): Promise<string> {
    return this.inner.readTextFile(path);
  }
  rename(from: string, to: string): Promise<void> {
    return this.inner.rename(from, to);
  }
}

describe('JobReporter', () => {
  it('writes the percentage it was told', async () => {
    await withDir(async (dir) => {
      let clock = 0;
      const reporter = new JobReporter({
        fs: new NodeFs(),
        jobsDir: dir,
        initial: initial(dir),
        log: new JobLog(join(dir, 'j.log')),
        now: () => clock,
        throttleMs: 100,
      });
      reporter.report({ stage: 'transcribing', fraction: 0.46 });
      clock = 1000;
      reporter.report({ stage: 'transcribing', fraction: 0.47 });
      await reporter.finish({ ok: true });
      const state = await readJobState(new NodeFs(), dir, initial(dir).id);
      expect(state?.percent).toBe(100);
      expect(state?.state).toBe('done');
      expect(state?.result).toEqual({ ok: true });
    });
  });

  it('never lowers the percentage', async () => {
    await withDir(async (dir) => {
      let clock = 0;
      const reporter = new JobReporter({
        fs: new NodeFs(),
        jobsDir: dir,
        initial: initial(dir),
        log: new JobLog(join(dir, 'j.log')),
        now: () => clock,
        throttleMs: 0,
      });
      reporter.report({ stage: 'a', fraction: 0.6 });
      clock = 10_000;
      reporter.report({ stage: 'b', fraction: 0.2 });
      clock = 20_000;
      await reporter.flush();
      const state = await readJobState(new NodeFs(), dir, initial(dir).id);
      expect(state?.percent).toBe(60);
      expect(state?.stage).toBe('b');
    });
  });

  it('throttles writes but never throttles the terminal one', async () => {
    await withDir(async (dir) => {
      const counting = new CountingFs();
      const clock = 0;
      const reporter = new JobReporter({
        fs: counting,
        jobsDir: dir,
        initial: initial(dir),
        log: new JobLog(join(dir, 'j.log')),
        now: () => clock,
        throttleMs: 2000,
      });
      for (let i = 1; i <= 50; i += 1) reporter.report({ stage: 's', fraction: i / 100 });
      await reporter.flush();
      const throttled = counting.writes;
      await reporter.finish(null);
      expect(throttled).toBeLessThan(5);
      expect(counting.writes).toBeGreaterThan(throttled);
    });
  });

  it('omits the ETA below five per cent and offers one above it', async () => {
    await withDir(async (dir) => {
      let clock = 0;
      const reporter = new JobReporter({
        fs: new NodeFs(),
        jobsDir: dir,
        initial: initial(dir),
        log: new JobLog(join(dir, 'j.log')),
        now: () => clock,
        throttleMs: 0,
      });
      reporter.report({ stage: 's', fraction: 0.02 });
      clock = 5000;
      await reporter.flush();
      expect((await readJobState(new NodeFs(), dir, initial(dir).id))?.etaSeconds).toBeUndefined();

      reporter.report({ stage: 's', fraction: 0.5 });
      clock = 60_000;
      await reporter.flush();
      const eta = (await readJobState(new NodeFs(), dir, initial(dir).id))?.etaSeconds;
      expect(eta).toBeGreaterThan(0);
    });
  });

  it('keeps a stage with no fraction, without touching the percentage', async () => {
    await withDir(async (dir) => {
      const reporter = new JobReporter({
        fs: new NodeFs(),
        jobsDir: dir,
        initial: initial(dir),
        log: new JobLog(join(dir, 'j.log')),
        now: () => 0,
        throttleMs: 0,
      });
      reporter.report({ stage: 'x', fraction: 0.3 });
      reporter.report({ stage: 'diarizing' });
      await reporter.flush();
      const state = await readJobState(new NodeFs(), dir, initial(dir).id);
      expect(state?.stage).toBe('diarizing');
      expect(state?.percent).toBe(30);
    });
  });

  it('records a failure as a message, with no stack', async () => {
    await withDir(async (dir) => {
      const reporter = new JobReporter({
        fs: new NodeFs(),
        jobsDir: dir,
        initial: initial(dir),
        log: new JobLog(join(dir, 'j.log')),
      });
      await reporter.fail('whisper failed: exit 1');
      const state = await readJobState(new NodeFs(), dir, initial(dir).id);
      expect(state?.state).toBe('failed');
      expect(state?.error).toBe('whisper failed: exit 1');
      expect(state?.finishedAt).not.toBeNull();
    });
  });

  it('reports into an unwritable directory without throwing', async () => {
    await withDir(async (dir) => {
      const fs = new NodeFs();
      const blocker = join(dir, 'blocker');
      await fs.writeTextFile(blocker, 'x');
      const reporter = new JobReporter({
        fs,
        // A path inside a file: every write and every ensureDir fails.
        jobsDir: join(blocker, 'jobs'),
        initial: initial(dir),
        log: new JobLog(join(dir, 'j.log')),
        throttleMs: 0,
      });
      expect(() => reporter.report({ stage: 's', fraction: 0.5 })).not.toThrow();
      await expect(reporter.flush()).resolves.toBeUndefined();
      await expect(reporter.finish(null)).resolves.toBeUndefined();
    });
  });
});
