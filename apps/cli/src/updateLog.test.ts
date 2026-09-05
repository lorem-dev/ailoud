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
});
