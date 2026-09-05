import { describe, expect, it } from 'vitest';
import { FailureError, UsageError } from '@ailoud/core';
import type { PublishedVersion, VersionSource } from '@ailoud/core';
import { MemFs, FakeClock } from '@ailoud/core/testing';
import type { RunOptions, RunResult } from '@ailoud/providers';
import { buildProgram, exitCodeFor } from '../program.js';
import { context } from './testContext.js';
import { findAgent } from '../mcp/agents.js';
import { install } from '../mcp/install.js';
import { pruneProjects, readProjects, rememberProject } from '../projects.js';
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
      // Every test below is either interactive, or does not reach the
      // install spawn at all; the two tests that exercise the non-interactive
      // --force path override this explicitly.
      runCommand: async () => {
        throw new Error('runCommand should not be called while deps.interactive is true');
      },
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

  it('anchors the npm-global install beside the running node, not to a bare "npm"', async () => {
    // detectInstallMethod deliberately anchors on execPath because PATH's
    // npm can belong to a different Node than the one running us (nvm, fnm,
    // asdf, volta). Throwing that anchor away here and spawning bare 'npm'
    // would undo the whole reason execPath was threaded through in the first
    // place -- see this file's own doc comment on updateSelf.
    const ctx = withTarget();
    const calls: Array<[string, readonly string[]]> = [];
    const deps = npmGlobalDeps(ctx, {
      spawn: async (command, args) => {
        calls.push([command, args]);
        return 0;
      },
    });

    await updateSelf(deps, { force: true });

    expect(calls[0]).toEqual(['/usr/local/bin/npm', ['install', '-g', 'ailoud@1.0.1']]);
  });

  it('anchors the npm-global sweep beside the running node, not to a bare "ailoud"', async () => {
    // The rules text is compiled in, so the process being replaced holds the
    // old text. This asserts the spawned command is the installed binary's
    // `self sync`, resolved the same way the install command is -- a bare
    // 'ailoud' resolved off PATH could be a stale, unrelated install (see the
    // machine layout in task-8-review.md).
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
    expect(calls[1]).toEqual(['/usr/local/bin/ailoud', ['self', 'sync']]);
  });

  it('keeps the pnpm-global install as a bare "pnpm", deliberately', async () => {
    // pnpm's global bin comes from PNPM_HOME/corepack, not from any one
    // Node's install tree, so there is no execPath-equivalent anchor for the
    // install -- bare 'pnpm' IS the right resolution. Asserted explicitly so
    // nobody "fixes" this into a broken anchor later.
    const ctx = withTarget();
    const calls: Array<[string, readonly string[]]> = [];
    const pnpmRun = async (command: string, args: readonly string[]): Promise<RunResult> => {
      if (command === 'npm') return { code: 1, stdout: '', stderr: 'npm: not found' };
      if (args[0] === 'root') {
        return { code: 0, stdout: '/home/x/.local/share/pnpm/global/5/node_modules', stderr: '' };
      }
      return { code: 0, stdout: '/home/x/.local/share/pnpm', stderr: '' };
    };
    const deps = npmGlobalDeps(ctx, {
      packageRoot: '/home/x/.local/share/pnpm/global/5/node_modules/ailoud',
      run: pnpmRun,
      spawn: async (command, args) => {
        calls.push([command, args]);
        return 0;
      },
    });

    await updateSelf(deps, { force: true });

    expect(calls[0]).toEqual(['pnpm', ['add', '-g', 'ailoud@1.0.1']]);
  });

  it('invokes the pnpm-global sweep at the path "pnpm bin -g" reports', async () => {
    const ctx = withTarget();
    const calls: Array<[string, readonly string[]]> = [];
    const pnpmRun = async (command: string, args: readonly string[]): Promise<RunResult> => {
      if (command === 'npm') return { code: 1, stdout: '', stderr: 'npm: not found' };
      if (args[0] === 'root') {
        return { code: 0, stdout: '/home/x/.local/share/pnpm/global/5/node_modules', stderr: '' };
      }
      // args[0] === 'bin': what sweepCommandFor asks to anchor the sweep.
      return { code: 0, stdout: '/home/x/.local/share/pnpm', stderr: '' };
    };
    const deps = npmGlobalDeps(ctx, {
      packageRoot: '/home/x/.local/share/pnpm/global/5/node_modules/ailoud',
      run: pnpmRun,
      spawn: async (command, args) => {
        calls.push([command, args]);
        return 0;
      },
    });

    await updateSelf(deps, { force: true });

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(['/home/x/.local/share/pnpm/ailoud', ['self', 'sync']]);
  });

  it('prints the command to run by hand when the sweep cannot be spawned', async () => {
    const ctx = withTarget();
    const deps = npmGlobalDeps(ctx, {
      spawn: async (command) => {
        if (command === '/usr/local/bin/ailoud') throw new Error('ailoud: command not found');
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

  it('--force with no TTY fails rather than hangs when the manager wants input', async () => {
    // This is given its OWN short vitest timeout, deliberately: if a
    // regression ever routes this path back through the unbounded
    // `spawn` (runInteractive), that fake below never resolves, and this
    // test must show up as a FAILING test rather than hang the whole
    // suite -- this repository has been bitten by exactly that before.
    const ctx = withTarget();
    const deps = npmGlobalDeps(ctx, {
      interactive: false,
      // Would hang forever if updateSelf ever called this non-interactively.
      spawn: () => new Promise<number>(() => undefined),
      // What run() does when the bounded timeout actually fires: reject,
      // never resolve with a code -- so the real timeout can never present
      // as an ordinary non-zero exit.
      runCommand: async () => {
        throw new FailureError('pnpm timed out after 600000 ms and was killed');
      },
    });

    const error: unknown = await updateSelf(deps, { force: true }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(FailureError);
    expect((error as Error).message).toContain('timed out');
  }, 2000);

  it('logs a throwing install spawn, and does not trigger the sweep', async () => {
    // If the install spawn THROWS (e.g. the manager binary was not found)
    // rather than resolving with a non-zero code, the sweep is correctly
    // skipped -- but this used to leave the failure completely unlogged.
    const ctx = withTarget();
    const calls: Array<[string, readonly string[]]> = [];
    const deps = npmGlobalDeps(ctx, {
      spawn: async (command, args) => {
        calls.push([command, args]);
        throw new Error('npm: command not found');
      },
    });

    const error: unknown = await updateSelf(deps, { force: true }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('command not found');
    expect(calls).toHaveLength(1); // the install attempt only, never the sweep

    const log = await ctx.fs.readTextFile(updateLogPath(ctx.paths.userDataDir));
    expect(log).toContain('self update');
    expect(log).toContain('command not found');
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

describe('the sweep must survive bookkeeping failures (task 7 review)', () => {
  class AnnoyedFs extends MemFs {
    public constructor(private readonly failOn: string) {
      super({});
    }
    override async isDirectory(path: string): Promise<boolean> {
      if (path === this.failOn) throw new Error('EACCES: permission denied');
      return super.isDirectory(path);
    }
  }

  it('keeps a project whose directory cannot be read, instead of forgetting it', async () => {
    // EACCES is not evidence the project is gone -- revoked permissions or a
    // dead network mount answer the same way. Dropping the entry would forget
    // a project that still holds a rules block, silently and for good.
    const fs = new AnnoyedFs('/proj/locked');
    const clock = new FakeClock();
    const deps = { fs, clock, userDataDir: '/data/ailoud' };
    await rememberProject(deps, { path: '/proj/locked' });

    const dropped = await pruneProjects(deps);

    expect(dropped).toEqual([]);
    expect((await readProjects(deps)).map((entry) => entry.path)).toEqual(['/proj/locked']);
  });

  it('reports a failure instead of sweeping nothing when the registry cannot be read', async () => {
    // Unguarded, this ended the whole sweep with zero rows and zero log
    // lines, which is indistinguishable from "there was nothing to do".
    class UnreadableFs extends MemFs {
      override async readTextFile(path: string): Promise<string> {
        if (path.endsWith('projects.json')) throw new Error('EACCES: permission denied');
        return super.readTextFile(path);
      }
    }
    const fs = new UnreadableFs({});
    await fs.writeTextFile('/data/ailoud/projects.json', '[]\n');
    const report = await syncProjects({
      fs,
      clock: new FakeClock(),
      userDataDir: '/data/ailoud',
      home: '/home/x',
    });

    expect(report.failed).toBe(true);
    expect(report.rows.some((row) => row.status.startsWith('failed:'))).toBe(true);
  });
});

describe('a partial refresh must not be reported as a plain failure', () => {
  const BLOCK = 'keep me\n<!-- AILOUD_START -->\nold rules\n<!-- AILOUD_END -->\n';

  /** Rejects writes to one agent's rules file, leaving the other's to succeed. */
  class OneUnwritableAgent extends MemFs {
    override async writeTextFile(path: string, content: string): Promise<void> {
      if (path.endsWith('GEMINI.md')) throw new Error('EROFS: read-only file system');
      return super.writeTextFile(path, content);
    }
  }

  it('says some agents were refreshed, and does not record the rules version', async () => {
    // One project can hold configs for several agents. Claude's block is
    // rewritten and Gemini's write then fails: reporting a plain `failed`
    // would claim nothing changed in a file this command had just edited.
    // And recording the version after a partial write would make the NEXT
    // sweep call the project `current` and skip the block still left stale.
    const fs = new OneUnwritableAgent({
      '/proj/a/CLAUDE.md': BLOCK,
      '/proj/a/GEMINI.md': BLOCK,
    });
    const clock = new FakeClock();
    const registry = { fs, clock, userDataDir: '/data/ailoud' };
    // The directory has to exist, or the sweep prunes the entry before it
    // ever reaches an agent.
    await fs.ensureDir('/proj/a');
    await rememberProject(registry, { path: '/proj/a' });

    const report = await syncProjects({ ...registry, home: '/home/x' });

    const row = report.rows.find((candidate) => candidate.path === '/proj/a');
    expect(row?.status).toMatch(/^failed:/);
    expect(row?.status).toContain('some agents were refreshed');
    expect(report.failed).toBe(true);
    const entry = (await readProjects(registry)).find((candidate) => candidate.path === '/proj/a');
    expect(entry?.rulesVersion).toBeUndefined();
  });
});
