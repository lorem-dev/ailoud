import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';
import type { Command } from 'commander';
import { confirm, isCancel } from '@clack/prompts';
import { FailureError, UsageError, chooseUpdateTarget } from '@ailoud/core';
import { detectInstallMethod, installCommandFor, run, runInteractive } from '@ailoud/providers';
import type { DetectOptions, RunOptions, RunResult } from '@ailoud/providers';
import type { CliContext } from '../wiring.js';
import { VERSION } from '../version.js';
import { AGENTS, defaultHome } from '../mcp/agents.js';
import { update } from '../mcp/install.js';
import type { AgentOutcome } from '../mcp/install.js';
import { pruneProjects, readProjects, rememberProject } from '../projects.js';
import type { ProjectsDeps } from '../projects.js';
import { appendUpdateLog } from '../updateLog.js';
import { isInteractive } from './setup.js';

/**
 * The only package this project ever asks the registry about. Never
 * `@ailoud/core` or `@ailoud/providers` -- they arrive as this package's own
 * dependencies, so their versions follow whatever `ailoud` itself resolves to.
 */
const PACKAGE_NAME = 'ailoud';

interface SelfCheckOptions {
  readonly json?: boolean;
}

export interface SelfCheckResult {
  readonly current: string;
  readonly target: string | null;
  readonly updatable: boolean;
}

/**
 * The version `ailoud` is running, and the newest one it could move to.
 *
 * Throws a `FailureError` when the lookup itself could not be performed --
 * the registry was unreachable, timed out, or answered with something this
 * build cannot read -- naming the host and the timeout so the message never
 * reads as "you are up to date" when the truth is "this could not be
 * checked". Finding no newer version is not a failure: that is `target ===
 * null` in an ordinary result, because a version check is not a test.
 */
export async function checkForUpdate(context: CliContext): Promise<SelfCheckResult> {
  let published;
  try {
    published = await context.versionSource.published(PACKAGE_NAME);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Name the timeout only when it WAS one. NpmRegistry already reports an
    // HTTP status or an unreadable body accurately, and wrapping those in
    // "timed out" sends the user to check a network that answered fine.
    const timedOut =
      error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    const how = timedOut ? ` (timed out after ${context.updateTimeoutMs}ms)` : '';
    throw new FailureError(
      `ailoud could not check ${context.updateRegistryHost} for a newer version${how}: ${reason}`,
    );
  }
  const target = chooseUpdateTarget(VERSION, published);
  return { current: VERSION, target, updatable: target !== null };
}

export function registerSelfCheck(parent: Command, context: CliContext): void {
  parent
    .command('check')
    .option('--json', 'print one JSON object instead of text')
    .description('Check whether a newer version of ailoud is published')
    .action(async (options: SelfCheckOptions) => {
      await context.ui.frame('Checking for updates', async () => {
        const result = await checkForUpdate(context);
        if (options.json === true) {
          // Raw, undecorated: a machine reader parses this, the same
          // contract `ls --json` keeps by writing straight through here
          // rather than through the decorated `ui`.
          context.write(JSON.stringify(result));
          return;
        }
        context.write(
          result.target === null
            ? `ailoud ${result.current} is already the newest published version.`
            : `ailoud ${result.current} can update to ${result.target}.`,
        );
      });
    });
}

/** What `syncProjects` needs beyond the project registry: where the agents' home lives. */
export interface SyncDeps extends ProjectsDeps {
  readonly home: string;
}

/**
 * One project's outcome, for the table `self sync` prints.
 *
 * The five shapes below are the whole point of the command: a sweep over
 * twenty projects must say which two actually changed, not "20 updated".
 */
export interface SyncRow {
  readonly path: string;
  readonly status: 'refreshed' | 'current' | 'no rules here' | 'gone' | `failed: ${string}`;
}

export interface SyncReport {
  readonly rows: readonly SyncRow[];
  readonly failed: boolean;
}

/** One line in the update log, naming only the action taken -- never a path's contents. */
async function logSyncAction(deps: SyncDeps, path: string, status: string): Promise<void> {
  await appendUpdateLog(deps, `${deps.clock.nowIso()} self sync ${status} ${path}`);
}

/**
 * Rewrites the rules block in every registered project with this build's
 * text, prunes entries whose directory is gone, and reports one row per
 * project.
 *
 * Reuses `update()` from mcp/install.ts unchanged: it already touches only
 * the bytes between the AILOUD markers and is already idempotent, which is
 * exactly the contract a sweep across other people's repositories needs.
 * Only the `local` scope is swept -- a project entry names one directory,
 * and the global agent files it: `~/.claude/CLAUDE.md` and friends -- are
 * not properties of any one project, so sweeping them once per registered
 * project would be both wrong and, over many projects, wasted work.
 *
 * `FileOutcome.action` (from `update()`, via `install()`) is what tells
 * "refreshed" (bytes changed) from "current" (nothing written) -- not a
 * version comparison -- so a sweep over twenty projects never claims twenty
 * edits when it made two.
 *
 * One project failing never stops the sweep: each is wrapped in its own
 * try/catch, so an unwritable repository lands one `failed:` row instead of
 * aborting the other nineteen. `report.failed` is what tells the caller to
 * exit non-zero.
 */
export async function syncProjects(deps: SyncDeps): Promise<SyncReport> {
  const rows: SyncRow[] = [];
  let failed = false;

  const dropped = await pruneProjects(deps);
  for (const entry of dropped) {
    rows.push({ path: entry.path, status: 'gone' });
    await logSyncAction(deps, entry.path, 'gone');
  }

  const projects = await readProjects(deps);
  for (const entry of projects) {
    try {
      const outcomes: AgentOutcome[] = [];
      for (const agent of AGENTS) {
        if (!agent.scopes.includes('local')) continue;
        const outcome = await update(deps.fs, agent, 'local', deps.home, entry.path);
        if (outcome !== null) outcomes.push(outcome);
      }

      if (outcomes.length === 0) {
        rows.push({ path: entry.path, status: 'no rules here' });
        await logSyncAction(deps, entry.path, 'no rules here');
        continue;
      }

      const changed = outcomes.some((outcome) =>
        outcome.files.some((file) => file.action !== 'unchanged'),
      );
      if (changed) {
        // Recorded immediately, bypassing rememberProject's 24-hour
        // throttle by design (see its own doc comment): a rules write just
        // happened, and that is what lets the NEXT sync explain a "current"
        // row rather than only report it.
        await rememberProject(deps, {
          path: entry.path,
          ...(entry.libraryDir === undefined ? {} : { libraryDir: entry.libraryDir }),
          rulesVersion: VERSION,
        });
        rows.push({ path: entry.path, status: 'refreshed' });
        await logSyncAction(deps, entry.path, 'refreshed');
      } else {
        rows.push({ path: entry.path, status: 'current' });
        await logSyncAction(deps, entry.path, 'current');
      }
    } catch (error) {
      failed = true;
      const reason = error instanceof Error ? error.message : String(error);
      const status = `failed: ${reason}` as const;
      rows.push({ path: entry.path, status });
      await logSyncAction(deps, entry.path, status);
    }
  }

  return { rows, failed };
}

export function registerSelfSync(parent: Command, context: CliContext): void {
  parent
    .command('sync')
    .description('Refresh the rules block in every project ailoud has been used in')
    .action(async () => {
      await context.ui.frame('Syncing rules', async () => {
        const report = await syncProjects({
          fs: context.fs,
          clock: context.clock,
          userDataDir: context.paths.userDataDir,
          home: defaultHome(),
        });

        if (report.rows.length === 0) {
          context.write('No projects registered yet.');
          return;
        }
        for (const row of report.rows) {
          context.write(`${row.status}: ${row.path}`);
        }
        if (report.failed) {
          throw new FailureError(
            'ailoud self sync: at least one project failed to refresh; see the rows above.',
          );
        }
      });
    });
}

/**
 * What `updateSelf` needs beyond `checkForUpdate`'s `CliContext`: everything
 * that touches the machine or spawns another process, grouped here rather
 * than folded into `CliContext` itself so a test can replace every one of
 * them. `registerSelfUpdate` below is the only place the real node
 * primitives are ever passed in; every test in this file passes fakes
 * instead, so no test ever spawns a real process.
 */
export interface SelfUpdateDeps {
  readonly context: CliContext;
  /**
   * `process.execPath`: which Node is running us, so a global install under
   * nvm, fnm, asdf or volta is recognised even though the npm on PATH often
   * belongs to a different Node version. Required by `DetectOptions` -- see
   * its doc comment in `installMethod.ts`.
   */
  readonly execPath: string;
  /** Where this package sits on disk, resolved from `import.meta.url`. */
  readonly packageRoot: string;
  readonly realpath: (path: string) => Promise<string>;
  /**
   * What `detectInstallMethod` calls to ask `npm`/`pnpm` for their global
   * root. Bounded to 10 seconds in production by `boundedDetectRun` -- see
   * its own doc comment -- so a hung `npm root -g` cannot hang the whole
   * command.
   */
  readonly run: DetectOptions['run'];
  /**
   * Runs a subprocess with the parent's own stdio, so its output streams to
   * the real terminal as it happens, and resolves to its exit code. Bound to
   * `runInteractive` (from `@ailoud/providers`) in production. This is the
   * one seam that would otherwise run a real package manager, so every test
   * in this file injects a fake here instead of that binding.
   */
  readonly spawn: (command: string, args: readonly string[]) => Promise<number>;
  /**
   * Whether there is a real terminal to confirm on: both ends are a TTY, and
   * this is not CI. See `isInteractive` in `setup.ts`.
   */
  readonly interactive: boolean;
  /** Overrides `@clack/prompts`' `confirm` in tests. */
  readonly confirmImpl?: (message: string) => Promise<boolean>;
}

export interface SelfUpdateOptions {
  readonly force?: boolean;
  readonly dryRun?: boolean;
}

/**
 * Wraps a `run` implementation so every call `detectInstallMethod` makes
 * through it carries a hard 10 second cap.
 *
 * Detection happens automatically, before anything is printed or confirmed --
 * unlike the package-manager spawn later in `updateSelf`, which only runs
 * after the user has already seen and agreed to the plan. `run()`'s own
 * default timeout is thirty minutes (see `providers/process/run.ts`); left at
 * that default, a hung `npm root -g` would hang `self update` for half an
 * hour with nothing on screen to explain why.
 */
export function boundedDetectRun(
  runImpl: (command: string, args: readonly string[], options?: RunOptions) => Promise<RunResult>,
): DetectOptions['run'] {
  return (command, args) => runImpl(command, args, { timeoutMs: 10_000 });
}

/** One line in the update log, naming only the action taken. */
async function logUpdateAction(context: CliContext, status: string): Promise<void> {
  await appendUpdateLog(
    { fs: context.fs, userDataDir: context.paths.userDataDir },
    `${context.clock.nowIso()} self update ${status}`,
  );
}

/** The real `confirm`, the way `commands/setup.ts` uses it: `isCancel` is "no". */
const defaultConfirm = async (message: string): Promise<boolean> => {
  const answer = await confirm({ message });
  if (isCancel(answer)) return false;
  return answer === true;
};

/**
 * Installs a newer ailoud, then re-syncs the rules block through a fresh
 * subprocess -- never in this one.
 *
 * That last part is load-bearing, not a style choice: the rules text is
 * compiled into the code, so the process being replaced still holds the OLD
 * text. If IT swept the registered projects, it would write the old rules
 * into every one of them -- precisely the staleness `self sync` exists to
 * fix. So the sweep only ever happens by spawning `ailoud self sync` as a
 * subprocess, resolved fresh off PATH after the install succeeded, which is
 * what picks up the binary the package manager just wrote.
 *
 * Follows the eight steps of the design's `self update` section in order:
 * resolve the target, detect the install method (three of its five kinds are
 * refusals), print the plan, confirm (skipped by `--force`; `--dry-run` stops
 * here, having changed nothing), spawn the package manager, spawn the new
 * binary's `self sync` only on success, and log the outcome.
 */
export async function updateSelf(deps: SelfUpdateDeps, options: SelfUpdateOptions): Promise<void> {
  const { context } = deps;

  const result = await checkForUpdate(context);
  if (result.target === null) {
    context.write(`ailoud ${result.current} is already the newest version you can update to`);
    return;
  }
  const target = result.target;

  const method = await detectInstallMethod({
    execPath: deps.execPath,
    packageRoot: deps.packageRoot,
    realpath: deps.realpath,
    run: deps.run,
  });

  // npx, project and unknown all carry a hint and nothing else: a refusal
  // that does not say what to do instead is just a failure. Narrowed by
  // `method.kind` rather than by `installCommandFor(...) === null`, so
  // TypeScript knows `method.hint` exists on every branch that reads it.
  if (method.kind === 'npx' || method.kind === 'project' || method.kind === 'unknown') {
    context.write(method.hint);
    if (options.force === true) {
      // A refusal is information; a forced update that cannot happen is an
      // error, because --force asked for a guarantee this install method
      // cannot give.
      throw new FailureError(`ailoud self update cannot install this way: ${method.hint}`);
    }
    return;
  }

  const command = installCommandFor(method, target);
  if (command === null) {
    // Unreachable today: installCommandFor only returns null for the three
    // kinds handled above. Kept as a real check rather than a cast, so a
    // future InstallMethod variant fails loudly here instead of spawning
    // `undefined`.
    throw new FailureError('ailoud self update: no install command for this install method');
  }
  const managerCommand = command[0];
  if (managerCommand === undefined) {
    throw new FailureError('ailoud self update: the install command was empty');
  }
  const managerArgs = command.slice(1);

  const projects = await readProjects({
    fs: context.fs,
    clock: context.clock,
    userDataDir: context.paths.userDataDir,
  });

  context.write(`Current version: ${result.current}`);
  context.write(`Target version: ${target}`);
  context.write(`Install command: ${command.join(' ')}`);
  context.write(
    projects.length === 0
      ? 'No registered projects to refresh.'
      : `${projects.length} registered project${projects.length === 1 ? '' : 's'} will have their rules refreshed.`,
  );

  if (options.dryRun === true) {
    context.write('Dry run: nothing was changed.');
    return;
  }

  if (options.force !== true) {
    if (!deps.interactive) {
      throw new UsageError(
        `ailoud self update needs confirmation before installing ailoud ${target}, but there is ` +
          'no terminal to ask on. Re-run with --force to confirm in advance.',
      );
    }
    const confirmImpl = deps.confirmImpl ?? defaultConfirm;
    const consented = await confirmImpl(`Install ailoud ${target}?`);
    if (!consented) {
      context.write('Nothing was changed.');
      return;
    }
  }

  const code = await deps.spawn(managerCommand, managerArgs);
  if (code !== 0) {
    await logUpdateAction(context, `install failed, "${command.join(' ')}" exited ${code}`);
    throw new FailureError(`ailoud self update: "${command.join(' ')}" exited with code ${code}`);
  }
  await logUpdateAction(context, `installed ${target}`);
  context.write(`ailoud updated to ${target}.`);

  // The NEW binary, as a fresh subprocess -- never this one. See this
  // function's own doc comment for why that is not optional.
  try {
    await deps.spawn('ailoud', ['self', 'sync']);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    context.write(`Could not run "ailoud self sync" automatically (${reason}).`);
    context.write('Run it by hand: ailoud self sync');
  }
}

interface SelfUpdateCliOptions {
  readonly force?: boolean;
  readonly dryRun?: boolean;
}

export function registerSelfUpdate(parent: Command, context: CliContext): void {
  parent
    .command('update')
    .option(
      '--force',
      'skip confirmation; fail rather than refuse quietly when this install cannot be updated',
    )
    .option('--dry-run', 'print the plan without installing or syncing anything')
    .description('Install a newer ailoud, then refresh the rules block in every registered project')
    .action(async (options: SelfUpdateCliOptions) => {
      await context.ui.frame('Updating ailoud', async () => {
        const deps: SelfUpdateDeps = {
          context,
          execPath: process.execPath,
          // self.ts sits at <package root>/dist/commands/self.js once built;
          // '../..' from there is the package root itself.
          packageRoot: fileURLToPath(new URL('../..', import.meta.url)),
          realpath,
          run: boundedDetectRun(run),
          spawn: runInteractive,
          interactive: isInteractive(process.env, process.stdin.isTTY === true),
        };
        await updateSelf(deps, {
          force: options.force === true,
          dryRun: options.dryRun === true,
        });
      });
    });
}
