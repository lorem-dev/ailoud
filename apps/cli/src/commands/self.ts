import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';
import type { Command } from 'commander';
import { confirm, isCancel } from '@clack/prompts';
import { FailureError, UsageError, chooseUpdateTarget } from '@ailoud/core';
import {
  detectInstallMethod,
  installCommandFor,
  run,
  runInteractive,
  sweepCommandFor,
} from '@ailoud/providers';
import type { DetectOptions, RunOptions, RunResult } from '@ailoud/providers';
import type { CliContext } from '../wiring.js';
import { VERSION } from '../version.js';
import { AGENTS, defaultHome } from '../mcp/agents.js';
import { update } from '../mcp/install.js';
import type { AgentOutcome } from '../mcp/install.js';
import { pruneProjects, readProjects, registryPath, rememberProject } from '../projects.js';
import type { ProjectEntry, ProjectsDeps } from '../projects.js';
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
          context.ui.content(JSON.stringify(result));
          return;
        }
        context.ui.content(
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

  // Pruning and reading the registry are bookkeeping, and bookkeeping must
  // not be able to cancel the work. Unguarded, an EACCES on one registered
  // directory -- or on projects.json itself -- ended the whole sweep with no
  // rows and no log lines, which looks exactly like "there was nothing to do".
  let dropped: readonly ProjectEntry[] = [];
  try {
    dropped = await pruneProjects(deps);
  } catch (error) {
    failed = true;
    const reason = error instanceof Error ? error.message : String(error);
    rows.push({ path: registryPath(deps.userDataDir), status: `failed: ${reason}` });
    await logSyncAction(deps, registryPath(deps.userDataDir), `failed: ${reason}`);
  }
  for (const entry of dropped) {
    rows.push({ path: entry.path, status: 'gone' });
    await logSyncAction(deps, entry.path, 'gone');
  }

  let projects: readonly ProjectEntry[] = [];
  try {
    projects = await readProjects(deps);
  } catch (error) {
    failed = true;
    const reason = error instanceof Error ? error.message : String(error);
    rows.push({ path: registryPath(deps.userDataDir), status: `failed: ${reason}` });
    await logSyncAction(deps, registryPath(deps.userDataDir), `failed: ${reason}`);
  }
  for (const entry of projects) {
    try {
      const outcomes: AgentOutcome[] = [];
      const failures: string[] = [];
      for (const agent of AGENTS) {
        if (!agent.scopes.includes('local')) continue;
        // Caught PER AGENT, not around the loop. One project can hold configs
        // for several agents, and a throw on the second one used to report the
        // whole project as `failed` even though the first one's file had
        // already been rewritten -- telling the user nothing changed in a
        // directory this command had just edited.
        try {
          const outcome = await update(deps.fs, agent, 'local', deps.home, entry.path);
          if (outcome !== null) outcomes.push(outcome);
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }

      if (failures.length > 0) {
        failed = true;
        const wrote = outcomes.some((outcome) =>
          outcome.files.some((file) => file.action !== 'unchanged'),
        );
        // Deliberately NOT recording rulesVersion on a partial failure: some
        // agent here still has a stale block, and recording the version would
        // make the next sweep call this project `current` and skip it.
        const status = (
          wrote ? `failed: ${failures[0]} (some agents were refreshed)` : `failed: ${failures[0]}`
        ) as SyncRow['status'];
        rows.push({ path: entry.path, status });
        await logSyncAction(deps, entry.path, status);
        continue;
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
          context.ui.content('No projects registered yet.');
          return;
        }
        for (const row of report.rows) {
          const line = `${row.status}: ${row.path}`;
          if (row.status === 'refreshed') {
            context.ui.success(line);
          } else if (row.status.startsWith('failed:')) {
            context.ui.warn(line);
          } else {
            context.ui.note(line);
          }
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
   *
   * Used for the package-manager install ONLY when `interactive` is true --
   * `runInteractive` has no timeout by design, which is only safe when a real
   * terminal is watching and can interrupt it. Also used, unconditionally,
   * for the post-install `self sync` sweep, which never prompts for input.
   */
  readonly spawn: (command: string, args: readonly string[]) => Promise<number>;
  /**
   * Runs the package-manager install BOUNDED, for the one case `spawn`
   * (`runInteractive`) must never be used non-interactively: `--force` with
   * no terminal attached. Bound to `run` (from `@ailoud/providers`) in
   * production, given a generous timeout by `updateSelf` itself -- see its
   * own doc comment for why an unbounded wait is not safe there.
   */
  readonly runCommand: (
    command: string,
    args: readonly string[],
    options?: RunOptions,
  ) => Promise<RunResult>;
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

/**
 * How long the FORCED, non-interactive install is allowed to run before it
 * is treated as hung rather than merely slow. Ten minutes is ample for a
 * real package install; it exists only to turn "the manager is waiting on a
 * prompt nobody can answer" into a failure instead of an infinite wait. See
 * `updateSelf`'s own doc comment for the full reasoning.
 */
const FORCE_INSTALL_TIMEOUT_MS = 10 * 60_000;

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
 * subprocess.
 *
 * Both the install and the sweep are anchored, never a bare command name
 * resolved off PATH: under nvm/fnm/asdf/volta, PATH's `npm`/`ailoud` can
 * belong to an entirely different Node install than the one running us,
 * which would install the new version into the wrong tree and then sweep
 * every registered project with a DIFFERENT, possibly older, binary's
 * compiled-in rules -- both while reporting success. `installCommandFor` and
 * `sweepCommandFor` (`@ailoud/providers`) are the single places that decide
 * those two argvs, anchored to `deps.execPath` for `npm-global` and to
 * `pnpm bin -g` for `pnpm-global` -- see their own doc comments.
 *
 * The install itself only ever waits unboundedly (`deps.spawn`, bound to
 * `runInteractive`) when `deps.interactive` is true, i.e. a real terminal is
 * attached and can answer a prompt or interrupt it. `--force` with no
 * terminal is the one path that can still reach the install with nobody able
 * to answer a prompt -- some package managers do prompt on first global use
 * (`pnpm add -g` before its bin/PATH setup has run once) -- so that path uses
 * `deps.runCommand` (bound to the bounded `run`) instead, with a generous but
 * finite timeout, so a manager stuck waiting on input FAILS after that
 * timeout rather than hanging forever. This follows the same convention
 * `provision/llamaInstall.ts` uses for `runInteractive`: gate on
 * interactivity before ever calling it.
 *
 * Follows the eight steps of the design's `self update` section in order:
 * resolve the target, detect the install method (three of its five kinds are
 * refusals), print the plan, confirm (skipped by `--force`; `--dry-run` stops
 * here, having changed nothing), spawn the package manager, spawn the new
 * binary's `self sync` only on success, and log the outcome -- including a
 * throwing install spawn, which used to vanish unlogged.
 */
export async function updateSelf(deps: SelfUpdateDeps, options: SelfUpdateOptions): Promise<void> {
  const { context } = deps;

  const result = await checkForUpdate(context);
  if (result.target === null) {
    context.ui.content(`ailoud ${result.current} is already the newest version you can update to`);
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
    context.ui.content(method.hint);
    if (options.force === true) {
      // A refusal is information; a forced update that cannot happen is an
      // error, because --force asked for a guarantee this install method
      // cannot give.
      throw new FailureError(`ailoud self update cannot install this way: ${method.hint}`);
    }
    return;
  }

  const command = installCommandFor(method, target, deps.execPath);
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

  context.ui.content(`Current version: ${result.current}`);
  context.ui.content(`Target version: ${target}`);
  context.ui.content(`Install command: ${command.join(' ')}`);
  context.ui.content(
    projects.length === 0
      ? 'No registered projects to refresh.'
      : `${projects.length} registered project${projects.length === 1 ? '' : 's'} will have their rules refreshed.`,
  );

  if (options.dryRun === true) {
    context.ui.content('Dry run: nothing was changed.');
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
      context.ui.content('Nothing was changed.');
      return;
    }
  }

  let code: number;
  try {
    if (deps.interactive) {
      code = await deps.spawn(managerCommand, managerArgs);
    } else {
      // Only --force reaches here without a terminal (the gate above throws
      // otherwise). runInteractive has no timeout and would hang forever if
      // the manager wants to prompt, so this bounds the wait instead -- see
      // FORCE_INSTALL_TIMEOUT_MS and this function's own doc comment.
      const bounded = await deps.runCommand(managerCommand, managerArgs, {
        timeoutMs: FORCE_INSTALL_TIMEOUT_MS,
      });
      // run() buffers output rather than streaming it live the way
      // runInteractive does, so it has to be printed after the fact -- this
      // is the only way whoever (or whatever) is watching a --force,
      // no-terminal run sees what the manager actually did.
      if (bounded.stdout.length > 0) context.ui.content(bounded.stdout);
      if (bounded.stderr.length > 0) context.ui.content(bounded.stderr);
      code = bounded.code;
    }
  } catch (error) {
    // The install spawn THROWING (ENOENT, or the bounded run's own timeout)
    // is different from it exiting non-zero: the sweep is correctly skipped
    // either way, but a throw used to reach no log line at all.
    const reason = error instanceof Error ? error.message : String(error);
    await logUpdateAction(context, `install threw for "${command.join(' ')}": ${reason}`);
    throw error;
  }
  if (code !== 0) {
    await logUpdateAction(context, `install failed, "${command.join(' ')}" exited ${code}`);
    throw new FailureError(`ailoud self update: "${command.join(' ')}" exited with code ${code}`);
  }
  await logUpdateAction(context, `installed ${target}`);
  context.ui.content(`ailoud updated to ${target}.`);

  // The NEW binary, as a fresh subprocess -- never this one. See this
  // function's own doc comment for why that is not optional, and for why the
  // command below is anchored rather than a bare 'ailoud'.
  const sweep = await sweepCommandFor(method, deps.execPath, deps.run);
  const sweepCommand = sweep?.[0];
  if (sweep === null || sweepCommand === undefined) {
    context.ui.content('Could not determine the command to refresh rules automatically.');
    context.ui.content('Run it by hand: ailoud self sync');
    return;
  }
  const sweepArgs = sweep.slice(1);
  try {
    await deps.spawn(sweepCommand, sweepArgs);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    context.ui.content(`Could not run "ailoud self sync" automatically (${reason}).`);
    context.ui.content('Run it by hand: ailoud self sync');
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
          runCommand: run,
          interactive: isInteractive(process.env, process.stdin.isTTY === true),
        };
        await updateSelf(deps, {
          force: options.force === true,
          dryRun: options.dryRun === true,
        });
      });
    });
}
