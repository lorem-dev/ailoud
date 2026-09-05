import type { Command } from 'commander';
import { FailureError, chooseUpdateTarget } from '@ailoud/core';
import type { CliContext } from '../wiring.js';
import { VERSION } from '../version.js';
import { AGENTS, defaultHome } from '../mcp/agents.js';
import { update } from '../mcp/install.js';
import type { AgentOutcome } from '../mcp/install.js';
import { pruneProjects, readProjects, rememberProject } from '../projects.js';
import type { ProjectsDeps } from '../projects.js';
import { appendUpdateLog } from '../updateLog.js';

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
    throw new FailureError(
      `ailoud could not check ${context.updateRegistryHost} for a newer version ` +
        `(timed out after ${context.updateTimeoutMs}ms): ${reason}`,
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
