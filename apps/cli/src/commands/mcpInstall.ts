import { confirm, isCancel, multiselect, select } from '@clack/prompts';
import type { Command } from 'commander';
import { UsageError } from '@ailoud/core';
import type { CliContext } from '../wiring.js';
import { AGENTS, agentIds, findAgent, globalOnly } from '../mcp/agents.js';
import type { AgentTarget, Scope } from '../mcp/agents.js';
import { defaultHome } from '../mcp/agents.js';
import { detect, ensureProjectLibrary, install, uninstall, update } from '../mcp/install.js';
import type { AgentOutcome, FileOutcome } from '../mcp/install.js';
import { isInteractive } from './setup.js';
import { rememberProject } from '../projects.js';
import { VERSION } from '../version.js';

export interface Options {
  readonly target?: string;
  readonly location?: string;
  readonly yes?: boolean;
  /** Set by --allow-shell, cleared by --no-allow-shell, absent when neither was given. */
  readonly allowShell?: boolean;
}

function parseScope(raw: string): Scope {
  const wanted = raw.trim().toLowerCase();
  if (wanted === 'global' || wanted === 'local') return wanted;
  throw new UsageError(`unknown --location "${raw}"; choose "global" or "local".`);
}

/** Resolves `--target`: a comma-separated list, or "auto"/"all". */
async function parseTargets(
  context: CliContext,
  raw: string,
  home: string,
): Promise<AgentTarget[]> {
  const wanted = raw.trim().toLowerCase();
  if (wanted === 'all') return [...AGENTS];
  if (wanted === 'auto') {
    const found: AgentTarget[] = [];
    for (const agent of AGENTS) {
      if (await detect(context.fs, agent, home)) found.push(agent);
    }
    return found;
  }
  return wanted.split(',').map((id) => {
    const agent = findAgent(id);
    if (agent === undefined) {
      throw new UsageError(`unknown agent "${id}"; choose from: ${agentIds()}`);
    }
    return agent;
  });
}

/**
 * Asks which agents, with the installed ones pre-selected.
 *
 * Pre-selecting what was detected is the whole ergonomics of this prompt: the
 * common answer is "the ones I actually use", and it takes no keystrokes.
 * Agents that read no per-project configuration say so on their own line, so
 * the scope question that follows is not a surprise.
 */
async function askAgents(context: CliContext, home: string): Promise<AgentTarget[]> {
  const rows = [];
  for (const agent of AGENTS) {
    const found = await detect(context.fs, agent, home);
    rows.push({
      value: agent.id,
      label:
        `${agent.label} (${found ? 'detected' : 'not found'})` +
        (agent.scopes.includes('local') ? '' : ' -- global only'),
      found,
    });
  }
  const answer = await multiselect({
    message: 'Which agents should AILoud configure?',
    options: rows.map(({ value, label }) => ({ value, label })),
    initialValues: rows.filter((row) => row.found).map((row) => row.value),
    required: false,
  });
  if (isCancel(answer)) throw new UsageError('mcp install cancelled');
  return (answer as string[]).map((id) => findAgent(id)!);
}

/**
 * Asks global or per-project, but only when the answer can differ.
 *
 * With every chosen agent global-only there is nothing to ask, and asking
 * anyway then ignoring the answer is worse than not asking.
 */
async function askScope(agents: readonly AgentTarget[]): Promise<Scope> {
  if (globalOnly(agents)) return 'global';
  const answer = await select({
    message: 'Where should it be configured?',
    initialValue: 'local',
    options: [
      { value: 'local', label: 'This project only', hint: 'config files in this directory' },
      { value: 'global', label: 'Globally', hint: 'every project on this machine' },
    ],
  });
  if (isCancel(answer)) throw new UsageError('mcp install cancelled');
  return parseScope(String(answer));
}

/** The chosen agents that have a command allow-list at all. */
export function allowShellAgents(agents: readonly AgentTarget[]): readonly AgentTarget[] {
  return agents.filter((agent) => agent.permission !== undefined);
}

/**
 * Whether to add `ailoud` to the chosen agents' allow-lists.
 *
 * `--yes` alone answers no. It means "do not prompt", and resolving a
 * permission question nobody was asked as yes would widen an agent's
 * privileges in CI on the strength of a flag that says nothing about
 * permissions. `-y --allow-shell` is how to ask for it without a prompt.
 */
export async function resolveAllowShell(
  options: Options,
  interactive: boolean,
  agents: readonly AgentTarget[],
): Promise<boolean> {
  if (options.allowShell !== undefined) return options.allowShell;
  if (!interactive) return false;
  if (allowShellAgents(agents).length === 0) return false;
  const answer = await confirm({
    message: `Let these agents run "ailoud" without asking each time?`,
    initialValue: true,
  });
  if (isCancel(answer)) throw new UsageError('mcp install cancelled');
  return answer;
}

/**
 * One line for a file a `mcp install`/`uninstall`/`update` action touched (or
 * left alone). `created` and `updated` actually changed something on disk, so
 * they are marked as successes; `skipped` is a warning -- the user asked for
 * the allow-list entry and did not get it; the rest -- `unchanged`, `removed`,
 * `cleaned`, `absent` -- are informational: true, but not an achievement.
 */
export function reportFile(context: CliContext, file: FileOutcome): void {
  const line = `${file.action.padEnd(9)} ${file.path}`;
  if (file.action === 'created' || file.action === 'updated') {
    context.ui.success(line);
  } else if (file.action === 'skipped') {
    // The user asked for something and did not get it, which is not the same
    // as nothing needing doing. The detail comes from the writer, which knows
    // which of its refusals this was; the line used to say "not valid JSON"
    // for all of them, including a YAML file and a file that parsed fine.
    context.ui.warn(file.detail === undefined ? line : `${line} (${file.detail})`);
  } else {
    context.ui.note(line);
  }
}

/**
 * One line per agent whose grant covers only the directory it was made in.
 *
 * Copilot writes `locations["<cwd>"]` into a machine-wide file, so its outcome
 * row -- `created ~/.copilot/permissions-config.json` -- reads as approval for
 * everything the user does. The pre-prompt listing would have said otherwise,
 * but that listing is skipped whenever `--allow-shell` answered the question
 * outright, so it is said here instead: on the outcome path, which every way
 * of answering goes through.
 *
 * Only for an agent that actually got the entry. A `skipped` row means the
 * file was left alone, and announcing a grant that was not made is worse than
 * saying nothing.
 */
export function directoryGrants(
  outcomes: readonly AgentOutcome[],
  home: string,
  cwd: string,
): readonly string[] {
  const lines: string[] = [];
  for (const outcome of outcomes) {
    const permission = outcome.agent.permission;
    if (permission?.directoryScoped !== true) continue;
    const path = permission.path(outcome.scope, home, cwd);
    const granted = outcome.files.some((file) => file.path === path && file.action !== 'skipped');
    if (granted) {
      lines.push(`${outcome.agent.label} approves "ailoud" in ${cwd} only, not machine-wide.`);
    }
  }
  return lines;
}

/** One line per file touched, so the user can see exactly what changed. */
function report(context: CliContext, outcomes: readonly AgentOutcome[]): void {
  for (const outcome of outcomes) {
    for (const file of outcome.files) reportFile(context, file);
  }
  const notes = [...new Set(outcomes.map((outcome) => outcome.note))];
  for (const note of notes) context.ui.note(`note: ${note}`);
}

/**
 * Narrows a scope to the agents that support it, and says who was dropped.
 *
 * Silently installing a global-only agent globally while the user asked for
 * "this project only" would be a surprise; saying so is not.
 */
/**
 * Records the project a successful `mcp install` just wrote rules into, with
 * this build's version -- that is what lets a later `ailoud self sync` say
 * "current" for it instead of rewriting bytes that have not changed.
 *
 * Registration is bookkeeping, not the user's request: a full disk, a
 * read-only project directory, or any other write failure here must never
 * fail an install that otherwise succeeded. Any error is swallowed down to a
 * single debug line.
 */
async function registerAfterInstall(context: CliContext, cwd: string): Promise<void> {
  try {
    await rememberProject(
      { fs: context.fs, clock: context.clock, userDataDir: context.paths.userDataDir },
      { path: cwd, rulesVersion: VERSION },
    );
  } catch (error) {
    process.stderr.write(
      `ailoud: debug: could not register project "${cwd}": ` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

function splitByScope(
  agents: readonly AgentTarget[],
  scope: Scope,
): { readonly inScope: AgentTarget[]; readonly forcedGlobal: AgentTarget[] } {
  if (scope === 'global') return { inScope: [...agents], forcedGlobal: [] };
  return {
    inScope: agents.filter((agent) => agent.scopes.includes('local')),
    forcedGlobal: agents.filter((agent) => !agent.scopes.includes('local')),
  };
}

export function registerMcpInstall(parent: Command, context: CliContext): void {
  const home = (): string => defaultHome();
  const cwd = (): string => process.cwd();

  parent
    .command('install')
    .description('Configure AI agents to use AILoud over MCP, and add the rules they read')
    .option('-t, --target <ids>', `comma-separated agent ids, or "auto" or "all": ${agentIds()}`)
    .option('-l, --location <where>', '"global" or "local"')
    .option('-y, --yes', 'no prompts: --location=global --target=auto')
    .option('--allow-shell', 'pre-approve running "ailoud" in the agents\' allow-lists')
    .option('--no-allow-shell', "do not touch the agents' allow-lists")
    .action(async (options: Options) => {
      await context.ui.frame('Installing MCP', async () => {
        const interactive =
          isInteractive(process.env, process.stdin.isTTY === true) && options.yes !== true;

        const agents =
          options.target !== undefined
            ? await parseTargets(context, options.target, home())
            : interactive
              ? await askAgents(context, home())
              : await parseTargets(context, 'auto', home());

        if (agents.length === 0) {
          context.ui.warn('No agents selected, so nothing was configured.');
          context.ui.warn(`Run again with --target to name one: ${agentIds()}`);
          return;
        }

        const scope =
          options.location !== undefined
            ? parseScope(options.location)
            : interactive
              ? await askScope(agents)
              : 'global';

        const { inScope, forcedGlobal } = splitByScope(agents, scope);
        const outcomes: AgentOutcome[] = [];

        // A project library, so recordings imported here stay with this
        // project rather than joining the per-user collection.
        if (scope === 'local' && inScope.length > 0) {
          const library = await ensureProjectLibrary(context.fs, cwd());
          reportFile(context, library);
        }

        // Both the listing below and the question resolveAllowShell asks
        // must agree on which agents are involved, so both read from this
        // one call rather than filtering the chosen agents twice.
        const chosenAgents = [...inScope, ...forcedGlobal];
        const permissioned = allowShellAgents(chosenAgents);

        // The exact files and entries, before the question rather than after
        // it: "allow ailoud" is not something a user can weigh without
        // knowing which of their configuration files it edits.
        if (options.allowShell === undefined && interactive && permissioned.length > 0) {
          context.ui.note('The allow-list entry would be added to:');
          for (const agent of permissioned) {
            const at = agent.scopes.includes(scope) ? scope : 'global';
            context.ui.note(`  ${agent.label}: ${agent.permission!.path(at, home(), cwd())}`);
          }
        }
        const allowShell = await resolveAllowShell(options, interactive, chosenAgents);

        for (const agent of inScope) {
          outcomes.push(await install(context.fs, agent, scope, home(), cwd(), allowShell));
        }
        for (const agent of forcedGlobal) {
          context.ui.note(`${agent.label} reads no per-project config; configuring it globally.`);
          outcomes.push(await install(context.fs, agent, 'global', home(), cwd(), allowShell));
        }

        // Only once rules were actually written locally: a run that only
        // touched global-only agents wrote nothing into this project, and
        // has nothing to register.
        if (scope === 'local' && inScope.length > 0) {
          await registerAfterInstall(context, cwd());
        }

        for (const line of directoryGrants(outcomes, home(), cwd())) context.ui.note(line);
        report(context, outcomes);
      });
    });

  parent
    .command('uninstall')
    .description('Remove AILoud from AI agents, including the rules block')
    .option('-t, --target <ids>', `comma-separated agent ids, or "all" (default): ${agentIds()}`)
    .option('-l, --location <where>', '"global" or "local"')
    .option('-y, --yes', 'no prompts: --location=global --target=all')
    .action(async (options: Options) => {
      await context.ui.frame('Removing MCP', async () => {
        const interactive =
          isInteractive(process.env, process.stdin.isTTY === true) && options.yes !== true;
        const agents = await parseTargets(context, options.target ?? 'all', home());
        const scope =
          options.location !== undefined
            ? parseScope(options.location)
            : interactive
              ? await askScope(agents)
              : 'global';

        const { inScope, forcedGlobal } = splitByScope(agents, scope);
        const outcomes: AgentOutcome[] = [];
        for (const agent of inScope) {
          outcomes.push(await uninstall(context.fs, agent, scope, home(), cwd()));
        }
        for (const agent of forcedGlobal) {
          outcomes.push(await uninstall(context.fs, agent, 'global', home(), cwd()));
        }

        const touched = outcomes.flatMap((outcome) =>
          outcome.files.filter((file) => file.action === 'removed' || file.action === 'cleaned'),
        );
        if (touched.length === 0) {
          // Said plainly rather than reported as a success: an uninstall that
          // claims to have cleaned files it never touched teaches distrust.
          context.ui.warn('Nothing to remove: no agent here was configured for AILoud.');
          return;
        }
        report(context, outcomes);
        context.ui.note(
          'The .ailoud/ library directory was left alone; delete it by hand if you want it gone.',
        );
      });
    });

  parent
    .command('update')
    .description('Refresh what a previous install wrote, for already-configured agents only')
    .option('-l, --location <where>', '"global" or "local" (default: both)')
    .action(async (options: { readonly location?: string }) => {
      await context.ui.frame('Updating MCP', async () => {
        const scopes: Scope[] =
          options.location === undefined ? ['local', 'global'] : [parseScope(options.location)];
        const outcomes: AgentOutcome[] = [];
        for (const scope of scopes) {
          for (const agent of AGENTS) {
            if (!agent.scopes.includes(scope)) continue;
            const outcome = await update(context.fs, agent, scope, home(), cwd());
            if (outcome !== null) outcomes.push(outcome);
          }
        }
        if (outcomes.length === 0) {
          context.ui.warn('Nothing to update: no agent here is configured for AILoud.');
          context.ui.warn('Run "ailoud mcp install" first.');
          return;
        }
        report(context, outcomes);
      });
    });
}
