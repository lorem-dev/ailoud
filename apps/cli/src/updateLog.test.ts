import { describe, expect, it } from 'vitest';
import { MemFs } from '@ailoud/core/testing';
import { appendUpdateLog, updateLogPath } from './updateLog.js';

const DATA_DIR = '/data/ailoud';

describe('updateLogPath', () => {
  it('sits directly under the per-user data directory', () => {
    expect(updateLogPath(DATA_DIR)).toBe('/data/ailoud/update.log');
  });
});

describe('appendUpdateLog', () => {
  it('creates the log on first use', async () => {
    const fs = new MemFs({});
    expect(await fs.exists(updateLogPath(DATA_DIR))).toBe(false);

    await appendUpdateLog({ fs, userDataDir: DATA_DIR }, 'first line');

    expect(await fs.exists(updateLogPath(DATA_DIR))).toBe(true);
    expect(await fs.readTextFile(updateLogPath(DATA_DIR))).toBe('first line\n');
  });

  it('appends subsequent lines rather than overwriting', async () => {
    const fs = new MemFs({});

    await appendUpdateLog({ fs, userDataDir: DATA_DIR }, 'one');
    await appendUpdateLog({ fs, userDataDir: DATA_DIR }, 'two');
    await appendUpdateLog({ fs, userDataDir: DATA_DIR }, 'three');

    expect(await fs.readTextFile(updateLogPath(DATA_DIR))).toBe('one\ntwo\nthree\n');
  });

  it('does not touch a log under the 1 MB threshold', async () => {
    const fs = new MemFs({});

    await appendUpdateLog({ fs, userDataDir: DATA_DIR }, 'small');
    const content = await fs.readTextFile(updateLogPath(DATA_DIR));

    expect(content).toBe('small\n');
  });

  it('caps the log at the last 500 lines once it passes 1 MB', async () => {
    const fs = new MemFs({});
    // 20,000 lines at roughly 60 bytes each is comfortably over 1 MB.
    const seedLines = Array.from({ length: 20_000 }, (_, i) => `old line ${i} ${'x'.repeat(50)}`);
    await fs.ensureDir(DATA_DIR);
    await fs.writeTextFile(updateLogPath(DATA_DIR), `${seedLines.join('\n')}\n`);

    await appendUpdateLog({ fs, userDataDir: DATA_DIR }, 'the newest line');

    const content = await fs.readTextFile(updateLogPath(DATA_DIR));
    const lines = content.split('\n').filter((line) => line.length > 0);
    expect(lines.length).toBeLessThanOrEqual(500);
    // The truncation drops the OLDEST lines, never the write that triggered it.
    expect(lines[lines.length - 1]).toBe('the newest line');
    expect(lines[0]).not.toBe(seedLines[0]);
  });

  it('never contains more bytes than the 1 MB cap plus one line, after truncating', async () => {
    const fs = new MemFs({});
    const seedLines = Array.from({ length: 20_000 }, (_, i) => `old line ${i} ${'x'.repeat(50)}`);
    await fs.ensureDir(DATA_DIR);
    await fs.writeTextFile(updateLogPath(DATA_DIR), `${seedLines.join('\n')}\n`);

    await appendUpdateLog({ fs, userDataDir: DATA_DIR }, 'the newest line');

    const content = await fs.readTextFile(updateLogPath(DATA_DIR));
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThan(1024 * 1024);
  });

  it('never loses an entry to a second writer racing on the same file', async () => {
    // Simulates two processes (a scheduled `self sync` and a manual `self
    // update`, say) both calling appendUpdateLog close together. `RacingFs`
    // captures what THIS call read as its starting point, then -- while
    // that call is still building its own write -- lets a second, complete
    // call to appendUpdateLog run and commit first. A plain read-modify-write
    // (no re-check before committing) would then have the first call
    // overwrite the second's line outright when it finally writes, which is
    // exactly the defect found in review: "two processes both read, and the
    // second write drops the first's line with no error."
    class RacingFs extends MemFs {
      private reads = 0;
      private armed = true;
      override async readTextFile(path: string): Promise<string> {
        this.reads += 1;
        // Snapshot BEFORE letting the racing call run, so this call sees
        // the bytes as they were at ITS read, not after the race.
        const snapshot = await super.readTextFile(path);
        if (this.reads === 1 && this.armed) {
          this.armed = false;
          await appendUpdateLog({ fs, userDataDir: DATA_DIR }, 'second process');
        }
        return snapshot;
      }
    }
    const fs = new RacingFs({});
    await fs.ensureDir(DATA_DIR);
    await fs.writeTextFile(updateLogPath(DATA_DIR), 'start\n');

    await appendUpdateLog({ fs, userDataDir: DATA_DIR }, 'first process');

    const content = await fs.readTextFile(updateLogPath(DATA_DIR));
    const lines = content.split('\n').filter((l) => l.length > 0);
    expect(lines).toContain('second process');
    expect(lines).toContain('first process');
  });
});

describe('the append gives up rather than spinning forever', () => {
  it('drops the line after a bounded number of lost races', async () => {
    // The loop retries only on genuine contention, so hanging needs a
    // continuous stream of rival writers -- implausible for a once-per-update
    // diagnostic, and cheap to rule out entirely. A rival that ALWAYS commits
    // between the re-read and the rename is what an unbounded loop could not
    // survive.
    //
    // What this test proves, exactly: that the bound EXISTS, because it
    // returns. It does NOT turn a regression into a clean failure --
    // measured: with the bound removed this test HANGS, and vitest's
    // per-test timeout does not preempt it, because the loop awaits only
    // already-resolved promises and never yields to a timer. So if this ever
    // hangs instead of failing, the bound is what went missing. Stated
    // plainly because the first version of this comment claimed the timeout
    // would catch it, and that was untrue.
    class AlwaysLoses extends MemFs {
      public reads = 0;
      public override async readTextFile(path: string): Promise<string> {
        this.reads += 1;
        // Every second read -- the verification read -- reports different
        // bytes, so the attempt always looks lost.
        if (path.endsWith('update.log') && this.reads % 2 === 0) {
          return `rival line ${this.reads}\n`;
        }
        return super.readTextFile(path).catch(() => '');
      }
      public override async exists(): Promise<boolean> {
        return true;
      }
    }
    const fs = new AlwaysLoses({});

    await expect(appendUpdateLog({ fs, userDataDir: DATA_DIR }, 'mine')).resolves.toBeUndefined();
  }, 5000);
});
