import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JobLog } from './log.js';

describe('JobLog', () => {
  it('appends lines in order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ailoud-log-'));
    try {
      const path = join(dir, 'j.log');
      const log = new JobLog(path);
      log.append('one');
      log.append('two');
      await log.flush();
      await expect(readFile(path, 'utf8')).resolves.toBe('one\ntwo\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('swallows a write failure instead of raising it', async () => {
    // A path inside a file, which cannot be a directory: every write fails.
    const dir = await mkdtemp(join(tmpdir(), 'ailoud-log-'));
    try {
      const blocker = join(dir, 'blocker');
      await writeFile(blocker, 'x');
      const log = new JobLog(join(blocker, 'nested.log'));
      log.append('one');
      await expect(log.flush()).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
