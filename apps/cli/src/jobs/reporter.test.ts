import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeFs } from '@ailoud/providers';
import type { Fs, TempDir, TempFile } from '@ailoud/core';
import { JobLog } from './log.js';
import { JobReporter } from './reporter.js';
import { jobStatePath, readJobState } from './state.js';
import type { JobState } from './state.js';

/** Reads and parses the state file, for assertions that need to see which keys are truly absent. */
async function readRawState(dir: string, id: string): Promise<Record<string, unknown>> {
  const raw = await readFile(jobStatePath(dir, id), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

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
 * Lets an already-queued async write actually run, without forcing a new
 * one the way `reporter.flush()` would. `report()` only *starts* a write on
 * the reporter's internal promise chain -- the chain's `.then()` callback
 * does not run until the current synchronous stretch of the test yields to
 * the event loop, and the underlying filesystem I/O settles on a later
 * macrotask, not merely the next microtask. A real setTimeout gives both a
 * chance to complete before the next assertion reads `counting.writes`.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
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

  it('throttles writes, resumes once the window elapses, and never throttles the terminal write', async () => {
    await withDir(async (dir) => {
      const counting = new CountingFs();
      let clock = 0;
      const reporter = new JobReporter({
        fs: counting,
        jobsDir: dir,
        initial: initial(dir),
        log: new JobLog(join(dir, 'j.log')),
        now: () => clock,
        throttleMs: 2000,
      });
      // With the clock frozen, only the very first report can write: this
      // alone would also pass an implementation that stopped writing
      // permanently after call one, so it does not by itself prove
      // throttling -- the clock advance below does. settle() (not flush())
      // is used to observe the count here: flush() always forces a write of
      // its own, which would make the count go up regardless of whether the
      // throttle window had actually elapsed, and so would not prove
      // resumption at all.
      for (let i = 1; i <= 25; i += 1) reporter.report({ stage: 's', fraction: i / 100 });
      await settle();
      const beforeWindow = counting.writes;
      expect(beforeWindow).toBeLessThan(5);

      // A full throttle window later, the next report must write again --
      // this is what distinguishes "throttled" from "never writes again".
      clock = 2000;
      reporter.report({ stage: 's', fraction: 0.26 });
      await settle();
      expect(counting.writes).toBeGreaterThan(beforeWindow);

      for (let i = 27; i <= 50; i += 1) reporter.report({ stage: 's', fraction: i / 100 });
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

  it('drops the ETA once the job finishes, rather than leaving a stale one', async () => {
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
      // Same shape as "writes the percentage it was told": the second
      // report computes a real ETA before finish() is ever called.
      reporter.report({ stage: 'transcribing', fraction: 0.46 });
      clock = 1000;
      reporter.report({ stage: 'transcribing', fraction: 0.47 });
      await reporter.finish({ ok: true });
      const state = await readRawState(dir, initial(dir).id);
      // Checks the parsed JSON document itself, not a typed read: a key
      // that was written as `etaSeconds: undefined` would still read as
      // `undefined` through readJobState, masking the bug this pins.
      expect('etaSeconds' in state).toBe(false);
    });
  });

  it('drops the ETA when the job fails, rather than leaving a stale one', async () => {
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
      await reporter.fail('whisper failed: exit 1');
      const state = await readRawState(dir, initial(dir).id);
      expect('etaSeconds' in state).toBe(false);
    });
  });

  it('clears an earlier ETA once a plain report reaches completion', async () => {
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
      reporter.report({ stage: 'transcribing', fraction: 0.5 });
      clock = 60_000;
      reporter.report({ stage: 'transcribing', fraction: 0.51 });
      await reporter.flush();
      const withEta = await readRawState(dir, initial(dir).id);
      expect('etaSeconds' in withEta).toBe(true);

      // fraction 1 with no finish() call at all -- eta() itself must clear
      // the key, not just finish()/fail().
      reporter.report({ stage: 'transcribing', fraction: 1 });
      await reporter.flush();
      const atCompletion = await readRawState(dir, initial(dir).id);
      expect('etaSeconds' in atCompletion).toBe(false);
    });
  });

  it('logs a stage or percentage change once, and repeats not at all', async () => {
    await withDir(async (dir) => {
      const logPath = join(dir, 'j.log');
      const reporter = new JobReporter({
        fs: new NodeFs(),
        jobsDir: dir,
        initial: initial(dir),
        log: new JobLog(logPath),
        now: () => 0,
        throttleMs: 0,
      });
      // First call is a genuine change from the initial "starting"/0%: logs.
      reporter.report({ stage: 'transcribing', fraction: 0.3 });
      // Two exact repeats: whisper-style flooding. Neither should log --
      // the bug this pins compared against the constructor's fixed initial
      // stage forever, so every one of these would have logged too.
      reporter.report({ stage: 'transcribing', fraction: 0.3 });
      reporter.report({ stage: 'transcribing', fraction: 0.3 });
      // A real stage change: logs again.
      reporter.report({ stage: 'diarizing', fraction: 0.3 });
      await reporter.flush();
      const lines = (await readFile(logPath, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('transcribing 30%');
      expect(lines[1]).toContain('diarizing 30%');
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
