import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lockPath, withProvisioningLock } from './setupLock.js';

async function dataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'laud-lock-'));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('withProvisioningLock', () => {
  it('runs the body and returns its value', async () => {
    const dir = await dataDir();
    await expect(withProvisioningLock(dir, async () => 'done')).resolves.toBe('done');
  });

  it('releases the lock afterwards', async () => {
    const dir = await dataDir();
    await withProvisioningLock(dir, async () => undefined);
    expect(await exists(lockPath(dir))).toBe(false);
  });

  it('holds the lock for the duration of the body, recording who holds it', async () => {
    const dir = await dataDir();
    await withProvisioningLock(dir, async () => {
      const held: unknown = JSON.parse(await readFile(lockPath(dir), 'utf8'));
      expect(held).toMatchObject({ pid: process.pid });
      expect((held as { startedAt: string }).startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  it('refuses a second run while the first holds the lock, naming the pid', async () => {
    const dir = await dataDir();
    await withProvisioningLock(dir, async () => {
      // This process is genuinely alive, so this is a live lock, not a stale
      // one -- the case that must be refused rather than taken over.
      await expect(withProvisioningLock(dir, async () => 'should not run')).rejects.toThrow(
        new RegExp(`pid ${process.pid}`),
      );
    });
  });

  it('releases the lock when the body throws', async () => {
    const dir = await dataDir();
    await expect(
      withProvisioningLock(dir, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // A lock nobody can release would be worse than no lock at all.
    expect(await exists(lockPath(dir))).toBe(false);
  });

  it('takes over a lock whose holder is no longer running', async () => {
    const dir = await dataDir();
    // PID 2^22 is above every default pid_max on macOS and Linux, so no
    // process can hold it -- a stale lock left by a crash.
    await writeFile(
      lockPath(dir),
      JSON.stringify({ pid: 4_194_304, startedAt: '2020-01-01T00:00:00.000Z' }),
      'utf8',
    );
    await expect(withProvisioningLock(dir, async () => 'took over')).resolves.toBe('took over');
  });

  it('treats an empty lock file as stale', async () => {
    const dir = await dataDir();
    // A run that died between creating the lock and writing to it.
    await writeFile(lockPath(dir), '', 'utf8');
    await expect(withProvisioningLock(dir, async () => 'took over')).resolves.toBe('took over');
  });

  it('treats an unparseable lock file as stale rather than erroring at the user', async () => {
    const dir = await dataDir();
    await writeFile(lockPath(dir), 'not json at all', 'utf8');
    await expect(withProvisioningLock(dir, async () => 'took over')).resolves.toBe('took over');
  });

  it('treats a lock file with a nonsense pid as stale', async () => {
    const dir = await dataDir();
    await writeFile(lockPath(dir), JSON.stringify({ pid: 'nope' }), 'utf8');
    await expect(withProvisioningLock(dir, async () => 'took over')).resolves.toBe('took over');
  });

  it('creates the data directory if it does not exist yet', async () => {
    const dir = join(await dataDir(), 'not', 'created', 'yet');
    await expect(withProvisioningLock(dir, async () => 'ok')).resolves.toBe('ok');
    await rm(dir, { recursive: true, force: true });
  });
});
