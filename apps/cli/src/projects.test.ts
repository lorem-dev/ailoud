import { describe, expect, it } from 'vitest';
import type { Clock } from '@ailoud/core';
import { MemFs } from '@ailoud/core/testing';
import {
  pruneProjects,
  readProjects,
  registryPath,
  rememberProject,
  type ProjectsDeps,
} from './projects.js';

const DATA_DIR = '/data/ailoud';
const DAY_MS = 24 * 60 * 60 * 1000;

class StubClock implements Clock {
  public constructor(private ms: number) {}
  public nowIso(): string {
    return new Date(this.ms).toISOString();
  }
  public advance(ms: number): void {
    this.ms += ms;
  }
}

/** A `MemFs` that records every write/rename/removeFile call, in order. */
class LoggingFs extends MemFs {
  readonly calls: string[] = [];
  override async writeTextFile(path: string, content: string): Promise<void> {
    this.calls.push(`write:${path}`);
    return super.writeTextFile(path, content);
  }
  override async rename(from: string, to: string): Promise<void> {
    this.calls.push(`rename:${from}->${to}`);
    return super.rename(from, to);
  }
  override async removeFile(path: string): Promise<void> {
    this.calls.push(`removeFile:${path}`);
    return super.removeFile(path);
  }
}

function deps(overrides: Partial<ProjectsDeps> = {}): ProjectsDeps {
  return {
    fs: new MemFs({}),
    clock: new StubClock(Date.parse('2026-01-01T00:00:00.000Z')),
    userDataDir: DATA_DIR,
    ...overrides,
  };
}

describe('rememberProject / readProjects', () => {
  it('creates the file on first registration', async () => {
    const d = deps();

    await rememberProject(d, { path: '/proj/a' });

    expect(await d.fs.exists(registryPath(DATA_DIR))).toBe(true);
    const projects = await readProjects(d);
    expect(projects).toEqual([
      {
        path: '/proj/a',
        firstSeen: '2026-01-01T00:00:00.000Z',
        lastSeen: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('records firstSeen once and moves lastSeen', async () => {
    const clock = new StubClock(Date.parse('2026-01-01T00:00:00.000Z'));
    const d = deps({ clock });

    await rememberProject(d, { path: '/proj/a' });
    clock.advance(DAY_MS + 1); // comfortably past the 24-hour throttle
    await rememberProject(d, { path: '/proj/a' });

    const [entry] = await readProjects(d);
    expect(entry).toBeDefined();
    expect(entry?.firstSeen).toBe('2026-01-01T00:00:00.000Z');
    expect(entry?.lastSeen).toBe(
      new Date(Date.parse('2026-01-01T00:00:00.000Z') + DAY_MS + 1).toISOString(),
    );
  });

  it('does not write again within 24 hours', async () => {
    const clock = new StubClock(Date.parse('2026-01-01T00:00:00.000Z'));
    const fs = new LoggingFs({});
    const d = deps({ clock, fs });

    await rememberProject(d, { path: '/proj/a' });
    const writesAfterFirstCall = fs.calls.length;

    clock.advance(1000); // one second later: well within the 24-hour window
    await rememberProject(d, { path: '/proj/a' });

    expect(fs.calls.length).toBe(writesAfterFirstCall); // no additional write or rename
    const [entry] = await readProjects(d);
    expect(entry?.lastSeen).toBe('2026-01-01T00:00:00.000Z'); // unchanged
  });

  it('writes again once lastSeen is older than 24 hours', async () => {
    const clock = new StubClock(Date.parse('2026-01-01T00:00:00.000Z'));
    const fs = new LoggingFs({});
    const d = deps({ clock, fs });

    await rememberProject(d, { path: '/proj/a' });
    const writesAfterFirstCall = fs.calls.length;

    clock.advance(DAY_MS); // exactly 24 hours later
    await rememberProject(d, { path: '/proj/a' });

    expect(fs.calls.length).toBeGreaterThan(writesAfterFirstCall);
    const [entry] = await readProjects(d);
    expect(entry?.lastSeen).toBe(
      new Date(Date.parse('2026-01-01T00:00:00.000Z') + DAY_MS).toISOString(),
    );
  });

  it('records rulesVersion when rules were written', async () => {
    const clock = new StubClock(Date.parse('2026-01-01T00:00:00.000Z'));
    const d = deps({ clock });

    await rememberProject(d, { path: '/proj/a', rulesVersion: '1.2.0' });
    const [afterFirst] = await readProjects(d);
    expect(afterFirst?.rulesVersion).toBe('1.2.0');

    // A rules write is significant enough to record immediately, even though
    // the 24-hour throttle would otherwise skip a plain touch.
    clock.advance(1000);
    await rememberProject(d, { path: '/proj/a', rulesVersion: '1.3.0' });
    const [afterSecond] = await readProjects(d);
    expect(afterSecond?.rulesVersion).toBe('1.3.0');
    expect(afterSecond?.lastSeen).toBe(clock.nowIso());
  });

  it('writes through a temporary file and renames', async () => {
    const fs = new LoggingFs({});
    const d = deps({ fs });

    await rememberProject(d, { path: '/proj/a' });

    const writeIndex = fs.calls.findIndex((c) => c.startsWith('write:'));
    const renameIndex = fs.calls.findIndex((c) => c.startsWith('rename:'));
    expect(writeIndex).toBeGreaterThanOrEqual(0);
    expect(renameIndex).toBeGreaterThan(writeIndex); // write happens strictly before rename

    const writtenPath = fs.calls[writeIndex]!.slice('write:'.length);
    const [, renamedFrom, renamedTo] = fs.calls[renameIndex]!.match(/^rename:(.*)->(.*)$/) ?? [];
    expect(renamedFrom).toBe(writtenPath);
    expect(renamedTo).toBe(registryPath(DATA_DIR));
    expect(writtenPath).not.toBe(registryPath(DATA_DIR)); // a real, distinct temp file
    // Nothing observed the target path directly written to; it only appears
    // as the rename's destination.
    expect(fs.calls.some((c) => c === `write:${registryPath(DATA_DIR)}`)).toBe(false);
  });

  it('recovers from a corrupt file by moving it aside', async () => {
    const fs = new MemFs({ [registryPath(DATA_DIR)]: '{not valid json' });
    const d = deps({ fs });

    expect(await readProjects(d)).toEqual([]);
    expect(await fs.exists(`${DATA_DIR}/projects.json.bad`)).toBe(true);
    expect(await fs.exists(registryPath(DATA_DIR))).toBe(false); // moved, not copied
  });

  it('recovers from a file that parses as JSON but not as a registry', async () => {
    const fs = new MemFs({ [registryPath(DATA_DIR)]: JSON.stringify({ oops: true }) });
    const d = deps({ fs });

    expect(await readProjects(d)).toEqual([]);
    expect(await fs.exists(`${DATA_DIR}/projects.json.bad`)).toBe(true);
  });
});

describe('pruneProjects', () => {
  async function seedRegistry(fs: MemFs, entries: unknown[]): Promise<void> {
    await fs.ensureDir(DATA_DIR);
    await fs.writeTextFile(registryPath(DATA_DIR), JSON.stringify(entries));
  }

  it('prunes an entry whose directory is gone and reports it', async () => {
    const fs = new MemFs({});
    await seedRegistry(fs, [
      {
        path: '/gone',
        firstSeen: '2026-01-01T00:00:00.000Z',
        lastSeen: '2026-01-01T00:00:00.000Z',
      },
    ]);
    // '/gone' is deliberately absent from fs.dirs.
    const d = deps({ fs });

    const dropped = await pruneProjects(d);

    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.path).toBe('/gone');
    expect(await readProjects(d)).toEqual([]);
  });

  it('keeps an entry whose .ailoud is gone but whose directory remains', async () => {
    const fs = new MemFs({});
    fs.dirs.add('/proj/b'); // the project directory still exists...
    // ...but its library, '/proj/b/.ailoud', is never added: it is gone.
    await seedRegistry(fs, [
      {
        path: '/proj/b',
        libraryDir: '/proj/b/.ailoud',
        firstSeen: '2026-01-01T00:00:00.000Z',
        lastSeen: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const d = deps({ fs });

    const dropped = await pruneProjects(d);

    expect(dropped).toEqual([]);
    const projects = await readProjects(d);
    expect(projects).toHaveLength(1);
    expect(projects[0]?.path).toBe('/proj/b');
  });

  it('never deletes anything on disk while pruning', async () => {
    const fs = new LoggingFs({});
    fs.dirs.add('/proj/kept');
    // '/proj/gone' is absent, so it will be dropped from the registry.
    await seedRegistry(fs, [
      {
        path: '/proj/kept',
        firstSeen: '2026-01-01T00:00:00.000Z',
        lastSeen: '2026-01-01T00:00:00.000Z',
      },
      {
        path: '/proj/gone',
        firstSeen: '2026-01-01T00:00:00.000Z',
        lastSeen: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const d = deps({ fs });

    const dropped = await pruneProjects(d);

    expect(dropped).toHaveLength(1);
    expect(fs.calls.some((c) => c.startsWith('removeFile:'))).toBe(false);
  });
});

describe('the three concurrency and throttle defects found in review', () => {
  it('keeps an entry another process committed while we were writing', async () => {
    // Two processes registering DIFFERENT projects both read the registry,
    // both write, and the second rename wins -- so the first project used to
    // vanish outright, not merely with a stale lastSeen. The merge re-reads
    // immediately before the rename and keeps paths it had not seen.
    class RacingFs extends MemFs {
      private reads = 0;
      override async readTextFile(path: string): Promise<string> {
        this.reads += 1;
        // The second read is the one inside writeRegistry, standing in for a
        // rival process that committed /proj/b in the meantime.
        if (this.reads === 2 && path === registryPath(DATA_DIR)) {
          return `${JSON.stringify([
            {
              path: '/proj/b',
              firstSeen: '2026-01-01T00:00:00.000Z',
              lastSeen: '2026-01-01T00:00:00.000Z',
            },
          ])}\n`;
        }
        return super.readTextFile(path);
      }
    }
    const fs = new RacingFs({});
    await fs.writeTextFile(registryPath(DATA_DIR), '[]\n');
    const d = deps({ fs });

    await rememberProject(d, { path: '/proj/a' });

    const paths = (await readProjects(d)).map((entry) => entry.path).sort();
    expect(paths).toEqual(['/proj/a', '/proj/b']);
  });

  it('does not fail the command when quarantining a corrupt registry fails', async () => {
    // Two processes meeting one corrupt registry both try to move it aside.
    // The loser's source is already gone, so rename answers ENOENT. Letting
    // that escape would turn a bad bookkeeping file into a broken command,
    // which is the one thing this path exists to prevent.
    class UnmovableFs extends MemFs {
      override async rename(): Promise<void> {
        throw new Error('ENOENT: no such file or directory');
      }
    }
    const fs = new UnmovableFs({});
    await fs.writeTextFile(registryPath(DATA_DIR), '{ not json');
    const d = deps({ fs });

    await expect(readProjects(d)).resolves.toEqual([]);
  });

  it('does not bypass the throttle when the rules version has not changed', async () => {
    // Presence is not enough: a caller passing the same version on every
    // touch would write on every command, which is the throttle gone.
    const fs = new LoggingFs({});
    const clock = new StubClock(Date.parse('2026-01-01T00:00:00.000Z'));
    const d = deps({ fs, clock });

    await rememberProject(d, { path: '/proj/a', rulesVersion: '1.0.0' });
    const afterFirst = fs.calls.length;
    clock.advance(1000);
    await rememberProject(d, { path: '/proj/a', rulesVersion: '1.0.0' });
    expect(fs.calls.length).toBe(afterFirst);

    // A CHANGED version is a real event and must be recorded at once.
    await rememberProject(d, { path: '/proj/a', rulesVersion: '1.0.1' });
    expect(fs.calls.length).toBeGreaterThan(afterFirst);
  });
});
