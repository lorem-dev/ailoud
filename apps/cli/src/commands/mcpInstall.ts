import { isCancel, multiselect, select } from '@clack/prompts';
import type { Command } from 'commander';
import { UsageError } from '@ailoud/core';
import type { CliContext } from '../wiring.js';
import { AGENTS, agentIds, findAgent, globalOnly } from '../mcp/agents.js';
import type { AgentTarget, Scope } from '../mcp/agents.js';
import { defaultHome } from '../mcp/agents.js';
import { detect, ensureProjectLibrary, install, uninstall, update } from '../mcp/install.js';
import type { AgentOutcome } from '../mcp/install.js';
import { isInteractive } from './setup.js';

interface Options {
  readonly target?: string;
  readonly location?: string;
  readonly yes?: boolean;
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

/** One line per file touched, so the user can see exactly what changed. */
function report(context: CliContext, outcomes: readonly AgentOutcome[]): void {
  for (const outcome of outcomes) {
    for (const file of outcome.files) {
      context.write(`${file.action.padEnd(9)} ${file.path}`);
    }
  }
  const notes = [...new Set(outcomes.map((outcome) => outcome.note))];
  for (const note of notes) context.write(`note: ${note}`);
}

/**
 * Narrows a scope to the agents that support it, and says who was dropped.
 *
 * Silently installing a global-only agent globally while the user asked for
 * "this project only" would be a surprise; saying so is not.
 */
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
          context.write('No agents selected, so nothing was configured.');
          context.write(`Run again with --target to name one: ${agentIds()}`);
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
          context.write(`${library.action.padEnd(9)} ${library.path}`);
        }

        for (const agent of inScope) {
          outcomes.push(await install(context.fs, agent, scope, home(), cwd()));
        }
        for (const agent of forcedGlobal) {
          context.write(`${agent.label} reads no per-project config; configuring it globally.`);
          outcomes.push(await install(context.fs, agent, 'global', home(), cwd()));
        }

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
          context.write('Nothing to remove: no agent here was configured for AILoud.');
          return;
        }
        report(context, outcomes);
        context.write(
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
          context.write('Nothing to update: no agent here is configured for AILoud.');
          context.write('Run "ailoud mcp install" first.');
          return;
        }
        report(context, outcomes);
      });
    });
}
