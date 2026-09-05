import { describe, expect, it } from 'vitest';
import { FailureError, UsageError } from '@ailoud/core';
import type { PublishedVersion, VersionSource } from '@ailoud/core';
import { MemFs, FakeClock } from '@ailoud/core/testing';
import type { RunOptions, RunResult } from '@ailoud/providers';
import { buildProgram, exitCodeFor } from '../program.js';
import { context } from './testContext.js';
import { findAgent } from '../mcp/agents.js';
import { install } from '../mcp/install.js';
import { readProjects, rememberProject } from '../projects.js';
import type { SyncDeps } from './self.js';
import { boundedDetectRun, syncProjects, updateSelf } from './self.js';
import type { SelfUpdateDeps } from './self.js';
import { updateLogPath } from '../updateLog.js';
import { VERSION } from '../version.js';

/** A VersionSource that answers with a fixed list, never touching the network. */
function source(published: readonly PublishedVersion[]): VersionSource {
  return { published: async () => published };
}

describe('ailoud self check', () => {
  it('reports the target it would move to', async () => {
    const ctx = { ...context(), versionSource: source([{ version: '1.0.1', deprecated: false }]) };
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'self', 'check']);
    expect(ctx.lines).toEqual(['ailoud 1.0.0 can update to 1.0.1.']);
  });

  it('says so when there is nothing newer', async () => {
    const ctx = { ...context(), versionSource: source([{ version: '1.0.0', deprecated: false }]) };
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'self', 'check']);
    expect(ctx.lines).toEqual(['ailoud 1.0.0 is already the newest published version.']);
    // A version check is not a test: it must exit 0 either way.
  });

  it('prints JSON with --json', async () => {
    const ctx = { ...context(), versionSource: source([{ version: '1.0.1', deprecated: false }]) };
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'self', 'check', '--json']);
    expect(JSON.parse(ctx.lines.join(''))).toEqual({
      current: '1.0.0',
      target: '1.0.1',
      updatable: true,
    });
  });

  it('prints JSON with no target when there is nothing newer', async () => {
    const ctx = { ...context(), versionSource: source([{ version: '1.0.0', deprecated: false }]) };
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'self', 'check', '--json']);
    expect(JSON.parse(ctx.lines.join(''))).toEqual({
      current: '1.0.0',
      target: null,
      updatable: false,
    });
  });

  it('fails with the host and the timeout when the registry is unreachable', async () => {
    const ctx = {
      ...context(),
      updateRegistryHost: 'registry.npmjs.org',
      updateTimeoutMs: 10_000,
      versionSource: {
        published: async (): Promise<readonly PublishedVersion[]> => {
          throw new Error('fetch failed');
        },
      },
    };
    // Exit 1: an explicit check that could not run must not read as "up to date".
    await expect(buildProgram(ctx).parseAsync(['node', 'ailoud', 'self', 'check'])).rejects.toThrow(
      FailureError,
    );
    const error: unknown = await buildProgram(ctx)
      .parseAsync(['node', 'ailoud', 'self', 'check'])
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FailureError);
    expect((error as Error).message).toContain('registry.npmjs.org');
    // NOT asserting a timeout here: "fetch failed" is a refused connection or
    // a bad name, and calling it a timeout sends the user to the wrong place.
    // The underlying reason has to survive instead.
    expect((error as Error).message).toContain('fetch failed');
    expect((error as Error).message).not.toContain('timed out');
    expect(exitCodeFor(error)).toBe(1);
  });

  it('exists as a hidden top-level alias, "ailoud check"', async () => {
    const ctx = { ...context(), versionSource: source([{ version: '1.0.0', deprecated: false }]) };
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'check']);
    expect(ctx.lines).toEqual(['ailoud 1.0.0 is already the newest published version.']);
  });

  it('answers to its one-letter alias inside the group', async () => {
    const ctx = { ...context(), versionSource: source([{ version: '1.0.0', deprecated: false }]) };
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'self', 'c']);
    expect(ctx.lines).toEqual(['ailoud 1.0.0 is already the newest published version.']);
  });
});

describe('syncProjects', () => {
  const USER_DATA_DIR = '/data/ailoud';
  const HOME = '/home/user';
  const claude = findAgent('claude')!;

  function deps(fs: MemFs): SyncDeps {
    return { fs, clock: new FakeClock(), userDataDir: USER_DATA_DIR, home: HOME };
  }

  /** Rewrites a project's CLAUDE.md so it no longer matches the current build's block. */
  async function makeStale(fs: MemFs, projectPath: string): Promise<void> {
    const rulesPath = `${projectPath}/CLAUDE.md`;
    const current = await fs.readTextFile(rulesPath);
    const stale = current.replace('## AILoud', '## AILoud (text from an older ailoud build)');
    await fs.writeTextFile(rulesPath, stale);
  }

  it('refreshes a rules block and reports it as refreshed', async () => {
    const fs = new MemFs({});
    await install(fs, claude, 'local', HOME, '/proj/a');
    const rulesPath = '/proj/a/CLAUDE.md';
    const current = await fs.readTextFile(rulesPath);
    await makeStale(fs, '/proj/a');

    const d = deps(fs);
    await rememberProject(d, { path: '/proj/a' });

    const report = await syncProjects(d);

    expect(report.rows).toEqual([{ path: '/proj/a', status: 'refreshed' }]);
    expect(report.failed).toBe(false);
    // Rewritten back to exactly the bytes the current build would have
    // written on a fresh install -- update() is idempotent by construction.
    expect(await fs.readTextFile(rulesPath)).toBe(current);
  });

  it('reports a project whose block is already current, without writing', async () => {
    class LoggingFs extends MemFs {
      readonly writes: string[] = [];
      override async writeTextFile(path: string, content: string): Promise<void> {
        this.writes.push(path);
        return super.writeTextFile(path, content);
      }
    }
    const fs = new LoggingFs({});
    await install(fs, claude, 'local', HOME, '/proj/a');

    const d = deps(fs);
    await rememberProject(d, { path: '/proj/a' });
    const writesBeforeSync = fs.writes.length;

    const report = await syncProjects(d);

    expect(report.rows).toEqual([{ path: '/proj/a', status: 'current' }]);
    expect(report.failed).toBe(false);
    // Only bookkeeping (the registry, the log) may be written from here on;
    // the project's own rules/config files must be untouched because
    // update() already found them byte-identical to the current build.
    const newWrites = fs.writes.slice(writesBeforeSync);
    expect(newWrites).not.toContain('/proj/a/CLAUDE.md');
    expect(newWrites).not.toContain('/proj/a/.mcp.json');
  });

  it('reports a project with no rules block as such', async () => {
    const fs = new MemFs({});
    fs.dirs.add('/proj/empty'); // the directory exists; ailoud was just never installed into it

    const d = deps(fs);
    await rememberProject(d, { path: '/proj/empty' });

    const report = await syncProjects(d);

    expect(report.rows).toEqual([{ path: '/proj/empty', status: 'no rules here' }]);
    expect(report.failed).toBe(false);
  });

  it('continues after one project fails, and exits non-zero', async () => {
    // Throws only once armed, so seeding the fixture (which itself writes
    // through this same Fs) is not what trips the failure.
    class FlakyFs extends MemFs {
      armed = false;
      override async writeTextFile(path: string, content: string): Promise<void> {
        if (this.armed && path === '/proj/b/CLAUDE.md') {
          throw new Error('EACCES: permission denied');
        }
        return super.writeTextFile(path, content);
      }
    }
    const fs = new FlakyFs({});
    await install(fs, claude, 'local', HOME, '/proj/a');
    await install(fs, claude, 'local', HOME, '/proj/b');
    await makeStale(fs, '/proj/a');
    await makeStale(fs, '/proj/b');
    fs.armed = true;

    const d = deps(fs);
    await rememberProject(d, { path: '/proj/a' });
    await rememberProject(d, { path: '/proj/b' });

    const report = await syncProjects(d);

    expect(report.failed).toBe(true);
    const byPath = new Map(report.rows.map((row) => [row.path, row.status]));
    // The other nineteen (here: the other one) still get refreshed.
    expect(byPath.get('/proj/a')).toBe('refreshed');
    expect(byPath.get('/proj/b')).toMatch(/^failed: /);
    expect(byPath.get('/proj/b')).toContain('permission denied');
  });

  it('prunes a project whose directory is gone', async () => {
    const fs = new MemFs({});
    const d = deps(fs);
    await rememberProject(d, { path: '/proj/gone' });
    // '/proj/gone' is deliberately never added to fs.dirs.

    const report = await syncProjects(d);

    expect(report.rows).toEqual([{ path: '/proj/gone', status: 'gone' }]);
    expect(report.failed).toBe(false);
    expect(await readProjects(d)).toEqual([]);
  });

  it('records rulesVersion so the next sync can say "current"', async () => {
    const fs = new MemFs({});
    await install(fs, claude, 'local', HOME, '/proj/a');
    await makeStale(fs, '/proj/a');

    const d = deps(fs);
    await rememberProject(d, { path: '/proj/a' });

    const first = await syncProjects(d);
    expect(first.rows).toEqual([{ path: '/proj/a', status: 'refreshed' }]);

    const [entry] = await readProjects(d);
    expect(entry?.rulesVersion).toBe(VERSION);

    // Nothing changed the second time: the rows come from update()'s own
    // byte comparison, not from re-reading rulesVersion, but recording it is
    // what a caller (a future "self status") would use to explain why.
    const second = await syncProjects(d);
    expect(second.rows).toEqual([{ path: '/proj/a', status: 'current' }]);
  });

  it('appends one line per run to the update log', async () => {
    const fs = new MemFs({});
    await install(fs, claude, 'local', HOME, '/proj/a');
    fs.dirs.add('/proj/empty');

    const d = deps(fs);
    await rememberProject(d, { path: '/proj/a' });
    await rememberProject(d, { path: '/proj/empty' });

    await syncProjects(d);

    const log = await fs.readTextFile(updateLogPath(USER_DATA_DIR));
    const lines = log.split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(2); // one line per project row this run produced
    expect(lines.some((line) => line.includes('/proj/a'))).toBe(true);
    expect(lines.some((line) => line.includes('/proj/empty'))).toBe(true);
  });

  it('caps the log rather than growing it forever', async () => {
    const fs = new MemFs({});
    fs.dirs.add('/proj/a');
    const seedLines = Array.from({ length: 20_000 }, (_, i) => `old line ${i} ${'x'.repeat(50)}`);
    await fs.ensureDir(USER_DATA_DIR);
    await fs.writeTextFile(updateLogPath(USER_DATA_DIR), `${seedLines.join('\n')}\n`);

    const d = deps(fs);
    await rememberProject(d, { path: '/proj/a' });

    await syncProjects(d);

    const log = await fs.readTextFile(updateLogPath(USER_DATA_DIR));
    const lines = log.split('\n').filter((line) => line.length > 0);
    expect(lines.length).toBeLessThanOrEqual(500);
    expect(lines[lines.length - 1]).toContain('/proj/a'); // the newest action is never lost
  });
});

describe('ailoud self sync (CLI)', () => {
  it('says so when no project is registered', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'self', 'sync']);
    expect(ctx.lines).toEqual(['No projects registered yet.']);
  });

  it('answers to its one-letter alias inside the group', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'self', 's']);
    expect(ctx.lines).toEqual(['No projects registered yet.']);
  });

  it('exists as a hidden top-level alias, "ailoud sync"', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'sync']);
    expect(ctx.lines).toEqual(['No projects registered yet.']);
  });

  it('prints one row per project and exits non-zero when one failed', async () => {
    class FlakyFs extends MemFs {
      armed = false;
      override async writeTextFile(path: string, content: string): Promise<void> {
        if (this.armed && path === '/proj/a/CLAUDE.md') {
          throw new Error('EACCES: permission denied');
        }
        return super.writeTextFile(path, content);
      }
    }
    const fs = new FlakyFs({});
    const claude = findAgent('claude')!;
    await install(fs, claude, 'local', '/home/user', '/proj/a');
    const rulesPath = '/proj/a/CLAUDE.md';
    const current = await fs.readTextFile(rulesPath);
    await fs.writeTextFile(rulesPath, current.replace('## AILoud', '## AILoud (old)'));
    fs.armed = true;

    const ctx = { ...context(), fs };
    await rememberProject(
      { fs, clock: ctx.clock, userDataDir: ctx.paths.userDataDir },
      { path: '/proj/a' },
    );

    const error: unknown = await buildProgram(ctx)
      .parseAsync(['node', 'ailoud', 'self', 'sync'])
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FailureError);
    expect(exitCodeFor(error)).toBe(1);
    expect(ctx.lines.some((line) => line.startsWith('failed:') && line.includes('/proj/a'))).toBe(
      true,
    );
  });
});

describe('boundedDetectRun', () => {
  it('gives detectInstallMethod a run bounded to 10 seconds', async () => {
    const seen: Array<{ command: string; args: readonly string[]; options?: RunOptions }> = [];
    const fakeRunImpl = async (
      command: string,
      args: readonly string[],
      options?: RunOptions,
    ): Promise<RunResult> => {
      seen.push({ command, args, ...(options === undefined ? {} : { options }) });
      return { code: 0, stdout: '', stderr: '' };
    };

    const bounded = boundedDetectRun(fakeRunImpl);
    await bounded('npm', ['root', '-g']);

    expect(seen).toEqual([
      { command: 'npm', args: ['root', '-g'], options: { timeoutMs: 10_000 } },
    ]);
  });
});

describe('updateSelf', () => {
  /** `npm root -g` answers this root; `pnpm` is never installed on this fake machine. */
  function fakeDetectRun(roots: { npm?: string; pnpm?: string }) {
    return async (command: string, _args: readonly string[]): Promise<RunResult> => {
      const root = command === 'npm' ? roots.npm : command === 'pnpm' ? roots.pnpm : undefined;
      if (root === undefined) return { code: 1, stdout: '', stderr: `${command}: not found` };
      return { code: 0, stdout: root, stderr: '' };
    };
  }

  /** A fake global npm install: packageRoot sits under the root `run` reports. */
  function npmGlobalDeps(
    ctx: ReturnType<typeof context>,
    overrides: Partial<SelfUpdateDeps> = {},
  ): SelfUpdateDeps {
    return {
      context: ctx,
      execPath: '/usr/local/bin/node',
      packageRoot: '/opt/homebrew/lib/node_modules/ailoud',
      realpath: async (p: string) => p,
      run: fakeDetectRun({ npm: '/opt/homebrew/lib/node_modules' }),
      spawn: async () => 0,
      interactive: true,
      ...overrides,
    };
  }

  function withTarget(): ReturnType<typeof context> {
    return { ...context(), versionSource: source([{ version: '1.0.1', deprecated: false }]) };
  }

  it('says so and changes nothing when there is nothing newer', async () => {
    const ctx = context(); // default versionSource reports the current VERSION
    const calls: Array<[string, readonly string[]]> = [];
    const deps = npmGlobalDeps(ctx, {
      spawn: async (command, args) => {
        calls.push([command, args]);
        return 0;
      },
    });

    await updateSelf(deps, {});

    expect(ctx.lines).toEqual([
      `ailoud ${VERSION} is already the newest version you can update to`,
    ]);
    expect(calls).toEqual([]);
  });

  it('prints a plan and changes nothing with --dry-run', async () => {
    const ctx = withTarget();
    const calls: Array<[string, readonly string[]]> = [];
    const deps = npmGlobalDeps(ctx, {
      spawn: async (command, args) => {
        calls.push([command, args]);
        return 0;
      },
    });

    await updateSelf(deps, { dryRun: true });

    expect(calls).toEqual([]);
    expect(ctx.lines.some((line) => line.includes('1.0.0'))).toBe(true);
    expect(ctx.lines.some((line) => line.includes('1.0.1'))).toBe(true);
    expect(ctx.lines.some((line) => line.includes('npm install -g ailoud@1.0.1'))).toBe(true);
    expect(ctx.lines.some((line) => line.toLowerCase().includes('dry run'))).toBe(true);
    expect(await ctx.fs.exists(updateLogPath(ctx.paths.userDataDir))).toBe(false);
  });

  it('refuses an npx install and prints the npx command, exiting 0', async () => {
    const ctx = withTarget();
    const deps = npmGlobalDeps(ctx, {
      packageRoot: '/Users/x/.npm/_npx/abcd1234/node_modules/ailoud',
    });

    await expect(updateSelf(deps, {})).resolves.toBeUndefined();

    expect(ctx.lines).toContain('npx ailoud@<version>');
  });

  it('refuses a project dependency, naming the project', async () => {
    const ctx = withTarget();
    const deps = npmGlobalDeps(ctx, {
      packageRoot: '/Users/x/code/some-app/node_modules/ailoud',
    });

    await expect(updateSelf(deps, {})).resolves.toBeUndefined();

    expect(ctx.lines.some((line) => line.includes('/Users/x/code/some-app'))).toBe(true);
  });

  it('exits non-zero when --force meets an install method it cannot use', async () => {
    // A refusal is information; a forced update that cannot happen is an error.
    const ctx = withTarget();
    const deps = npmGlobalDeps(ctx, {
      packageRoot: '/Users/x/code/some-app/node_modules/ailoud',
    });

    const error: unknown = await updateSelf(deps, { force: true }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(FailureError);
    expect(exitCodeFor(error)).toBe(1);
  });

  it('refuses without a terminal and names --force', async () => {
    // The rule the shared confirmation helper already enforces for `rm`.
    const ctx = withTarget();
    const deps = npmGlobalDeps(ctx, { interactive: false });

    const error: unknown = await updateSelf(deps, {}).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('--force');
  });

  it('declines when the user says no at the prompt, changing nothing', async () => {
    const ctx = withTarget();
    const calls: Array<[string, readonly string[]]> = [];
    const deps = npmGlobalDeps(ctx, {
      spawn: async (command, args) => {
        calls.push([command, args]);
        return 0;
      },
      confirmImpl: async () => false,
    });

    await updateSelf(deps, {});

    expect(calls).toEqual([]);
    expect(ctx.lines).toContain('Nothing was changed.');
  });

  it('spawns the detected manager with an argument array', async () => {
    const ctx = withTarget();
    const calls: Array<[string, readonly string[]]> = [];
    const deps = npmGlobalDeps(ctx, {
      spawn: async (command, args) => {
        calls.push([command, args]);
        return 0;
      },
    });

    await updateSelf(deps, { force: true });

    expect(calls[0]).toEqual(['npm', ['install', '-g', 'ailoud@1.0.1']]);
  });

  it('runs the NEW binary for the rules sweep, not this one', async () => {
    // The rules text is compiled in, so the process being replaced holds the
    // old text. This asserts the spawned command is the installed binary's
    // `self sync`, and it is the reason the sweep is a subprocess at all.
    const ctx = withTarget();
    const calls: Array<[string, readonly string[]]> = [];
    const deps = npmGlobalDeps(ctx, {
      spawn: async (command, args) => {
        calls.push([command, args]);
        return 0;
      },
    });

    await updateSelf(deps, { force: true });

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(['ailoud', ['self', 'sync']]);
  });

  it('prints the command to run by hand when the sweep cannot be spawned', async () => {
    const ctx = withTarget();
    const deps = npmGlobalDeps(ctx, {
      spawn: async (command) => {
        if (command === 'ailoud') throw new Error('ailoud: command not found');
        return 0;
      },
    });

    await expect(updateSelf(deps, { force: true })).resolves.toBeUndefined();

    expect(ctx.lines.some((line) => line.includes('ailoud self sync'))).toBe(true);
  });

  it('does not sweep when the install failed', async () => {
    const ctx = withTarget();
    const calls: Array<[string, readonly string[]]> = [];
    const deps = npmGlobalDeps(ctx, {
      spawn: async (command, args) => {
        calls.push([command, args]);
        return 1;
      },
    });

    const error: unknown = await updateSelf(deps, { force: true }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(FailureError);
    expect(calls).toHaveLength(1);
  });

  it('logs the outcome', async () => {
    const ctx = withTarget();
    const deps = npmGlobalDeps(ctx, { spawn: async () => 0 });

    await updateSelf(deps, { force: true });

    const log = await ctx.fs.readTextFile(updateLogPath(ctx.paths.userDataDir));
    expect(log).toContain('self update');
    expect(log).toContain('1.0.1');
  });
});

describe('ailoud self update (CLI wiring)', () => {
  it('is already the newest version, printed through the real command', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'self', 'update']);
    expect(ctx.lines).toEqual([
      `ailoud ${VERSION} is already the newest version you can update to`,
    ]);
  });

  it('answers to its one-letter alias inside the group', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'self', 'u']);
    expect(ctx.lines).toEqual([
      `ailoud ${VERSION} is already the newest version you can update to`,
    ]);
  });

  it('exists as a hidden top-level alias, "ailoud update"', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'update']);
    expect(ctx.lines).toEqual([
      `ailoud ${VERSION} is already the newest version you can update to`,
    ]);
  });
});

describe('the failure message found in review', () => {
  const throwing = (error: Error) => ({
    published: async (): Promise<readonly PublishedVersion[]> => {
      throw error;
    },
  });

  const messageFrom = async (error: Error): Promise<string> => {
    const ctx = {
      ...context(),
      updateRegistryHost: 'registry.npmjs.org',
      updateTimeoutMs: 10_000,
      versionSource: throwing(error),
    };
    const caught: unknown = await buildProgram(ctx)
      .parseAsync(['node', 'ailoud', 'self', 'check'])
      .catch((thrown: unknown) => thrown);
    expect(caught).toBeInstanceOf(FailureError);
    return (caught as Error).message;
  };

  it('does not call an HTTP error a timeout', async () => {
    // NpmRegistry already reports a status, or an unreadable body, accurately.
    // Framing every failure as "timed out" sent the user off to check a
    // network that had answered perfectly well.
    const message = await messageFrom(new Error('the npm registry answered 503 for ailoud'));
    expect(message).toContain('503');
    expect(message).not.toContain('timed out');
  });

  it('does call an actual timeout a timeout, with the wait', async () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    const message = await messageFrom(timeout);
    expect(message).toContain('timed out after 10000ms');
  });
});
