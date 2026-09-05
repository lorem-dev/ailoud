import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lockPath, withProvisioningLock } from './setupLock.js';

async function dataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ailoud-lock-'));
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

  it('leaves no scratch file behind after taking over a stale lock', async () => {
    // The takeover writes its own lock beside the path and renames over it,
    // because `rm` then create loses the race it looks like it wins. A rename
    // that failed, or a path built wrong, would leave the scratch file in the
    // data directory.
    const dir = await dataDir();
    await writeFile(
      lockPath(dir),
      JSON.stringify({ pid: 4_194_304, startedAt: '2020-01-01T00:00:00.000Z' }),
      'utf8',
    );
    let duringBody: string[] = [];
    await withProvisioningLock(dir, async () => {
      duringBody = await readdir(dir);
    });
    expect(duringBody).toEqual(['provisioning.lock']);
    expect(await readdir(dir)).toEqual([]);
  });

  it('records the taking-over process as the holder, not the stale one', async () => {
    const dir = await dataDir();
    await writeFile(
      lockPath(dir),
      JSON.stringify({ pid: 4_194_304, startedAt: '2020-01-01T00:00:00.000Z' }),
      'utf8',
    );
    let held: unknown;
    await withProvisioningLock(dir, async () => {
      held = JSON.parse(await readFile(lockPath(dir), 'utf8'));
    });
    // The read-back after the rename is what makes a losing takeover
    // detectable; this is the winning side of it.
    expect(held).toMatchObject({ pid: process.pid });
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

/**
 * Two runs at once, against the COMPILED lock, with a stale lock in place.
 *
 * Every other test here is single-threaded, which is why none of them caught
 * that the first two takeover implementations let both runs proceed -- a
 * concurrency test found 34 overlaps in 60 attempts. This is that test, small
 * enough to keep in the suite.
 */
describe('withProvisioningLock under contention', () => {
  const ITERATIONS = 12;
  const HOLD_MS = 120;

  it('lets exactly one of two simultaneous runs into the body', async () => {
    const dist = fileURLToPath(new URL('../dist/setupLock.js', import.meta.url));
    expect(existsSync(dist)).toBe(true); // the gate builds before it tests

    const scratch = await mkdtemp(join(tmpdir(), 'ailoud-lock-race-'));
    const worker = join(scratch, 'worker.mjs');
    await writeFile(
      worker,
      `import { appendFileSync } from "node:fs";
       import { withProvisioningLock } from ${JSON.stringify(dist)};
       const [dir, log] = process.argv.slice(2);
       try {
         await withProvisioningLock(dir, async () => {
           appendFileSync(log, \`ENTER \${process.pid}\n\`);
           await new Promise((r) => setTimeout(r, ${HOLD_MS}));
           appendFileSync(log, \`LEAVE \${process.pid}\n\`);
         });
       } catch {
         appendFileSync(log, \`REFUSED \${process.pid}\n\`);
       }`,
      'utf8',
    );

    let refusals = 0;
    for (let round = 0; round < ITERATIONS; round += 1) {
      const dir = join(scratch, `round-${round}`);
      await mkdir(dir, { recursive: true });
      // A stale lock: pid 2^22 is above every default pid_max, so nothing
      // holds it. This is the state a Ctrl-C or a crash leaves behind, and the
      // only state in which a takeover happens at all.
      await writeFile(
        lockPath(dir),
        JSON.stringify({ pid: 4_194_304, startedAt: '2020-01-01T00:00:00.000Z' }),
        'utf8',
      );
      const log = join(dir, 'log.txt');
      await writeFile(log, '', 'utf8');

      await Promise.all(
        [0, 1].map(
          () =>
            new Promise<void>((resolve) => {
              const child = spawn(process.execPath, [worker, dir, log], { stdio: 'ignore' });
              child.on('exit', () => resolve());
            }),
        ),
      );

      const lines = (await readFile(log, 'utf8')).split('\n').filter(Boolean);
      refusals += lines.filter((l) => l.startsWith('REFUSED')).length;
      // Nesting is the failure: ENTER, ENTER means both are inside the body.
      let inside = 0;
      for (const line of lines) {
        if (line.startsWith('ENTER')) inside += 1;
        if (line.startsWith('LEAVE')) inside -= 1;
        expect(inside, `round ${round}: ${lines.join(' | ')}`).toBeLessThanOrEqual(1);
      }
      expect(lines.filter((l) => l.startsWith('ENTER'))).toHaveLength(1);
    }

    // Without this the test could pass by never contending at all.
    expect(refusals).toBeGreaterThan(0);

    await rm(scratch, { recursive: true, force: true });
  }, 60_000);
});
