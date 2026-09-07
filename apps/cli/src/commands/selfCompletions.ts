import { isCancel, multiselect } from '@clack/prompts';
import type { Command } from 'commander';
import { UsageError } from '@ailoud/core';
import type { CliContext } from '../wiring.js';
import { describeTree, renderCompletions } from '../completions/generate.js';
import type { CommandNode, Shell } from '../completions/generate.js';
import { SHELL_TARGETS, detect, findShell, shellIds } from '../completions/shells.js';
import type { ShellTarget } from '../completions/shells.js';
import { install, refresh, uninstall } from '../completions/install.js';
import type { FileOutcome, Places, ShellOutcome } from '../completions/install.js';
import { isInteractive } from './setup.js';

interface Options {
  readonly shell?: string;
  readonly yes?: boolean;
}

/**
 * The directories the writers need, taken from the resolved paths rather than
 * from the environment.
 *
 * `userDataDir` and not `dataDir`: a completion script is a property of the
 * user's shell, not of one repository. Inside a project library `dataDir`
 * points at that project's `.ailoud/`, and a script written there would be
 * installed once per repository and lost on the next `cd`.
 */
export function placesFor(
  context: CliContext,
  env: Record<string, string | undefined> = process.env,
): Places {
  return {
    home: env['HOME'] ?? '',
    configHome: context.paths.configHome,
    userDataDir: context.paths.userDataDir,
  };
}

/**
 * The root command of the running invocation.
 *
 * Walked up from the action's own command rather than built afresh:
 * `buildProgram` needs a `CliContext`, which opens the database, and a
 * completion script does not need a library to be readable. Using the live
 * tree is also what guarantees the script describes the commands this build
 * actually has instead of a list kept beside them.
 */
export function rootOf(command: Command): Command {
  let at = command;
  while (at.parent !== null && at.parent !== undefined) at = at.parent;
  return at;
}

/** Resolves `--shell`: a comma-separated list, or "auto" for the detected ones. */
export async function parseShells(
  context: CliContext,
  raw: string,
  places: Places,
  env: Record<string, string | undefined>,
): Promise<ShellTarget[]> {
  const wanted = raw.trim().toLowerCase();
  if (wanted === 'all') return [...SHELL_TARGETS];
  if (wanted === 'auto') {
    const found: ShellTarget[] = [];
    for (const target of SHELL_TARGETS) {
      if (await detect(context.fs, target, places.home, places.configHome, env)) found.push(target);
    }
    return found;
  }
  return wanted.split(',').map((id) => {
    const target = findShell(id);
    if (target === undefined) {
      throw new UsageError(`unknown shell "${id}"; choose from: ${shellIds()}`);
    }
    return target;
  });
}

/**
 * Asks which shells, with the detected ones pre-selected.
 *
 * Pre-selecting what was found is the whole ergonomics of this prompt: the
 * common answer is "the ones I actually use", and it takes no keystrokes.
 */
async function askShells(
  context: CliContext,
  places: Places,
  env: Record<string, string | undefined>,
): Promise<ShellTarget[]> {
  const rows = [];
  for (const target of SHELL_TARGETS) {
    const found = await detect(context.fs, target, places.home, places.configHome, env);
    rows.push({
      value: target.shell,
      label: `${target.label} (${found ? 'detected' : 'not found'})`,
      found,
    });
  }
  const answer = await multiselect({
    message: 'Which shells should get completions?',
    options: rows.map(({ value, label }) => ({ value, label })),
    initialValues: rows.filter((row) => row.found).map((row) => row.value),
    required: false,
  });
  if (isCancel(answer)) throw new UsageError('self completions cancelled');
  return (answer as string[]).map((id) => findShell(id)!);
}

/**
 * The shells to act on.
 *
 * `--yes` here means `--shell auto`, which is deliberately unlike `--yes`
 * elsewhere in this CLI. Running `self completions install` IS the request to
 * install, so there is no unasked consent question for `--yes` to answer
 * wrongly -- it only says "do not make me pick from a list".
 */
async function chooseShells(
  context: CliContext,
  options: Options,
  places: Places,
  env: Record<string, string | undefined>,
): Promise<ShellTarget[]> {
  if (options.shell !== undefined) return parseShells(context, options.shell, places, env);
  const interactive = isInteractive(env, process.stdin.isTTY === true) && options.yes !== true;
  if (!interactive) return parseShells(context, 'auto', places, env);
  return askShells(context, places, env);
}

/** One line per file touched, so the user can see exactly what changed. */
function reportFile(context: CliContext, file: FileOutcome): void {
  const line = `${file.action.padEnd(9)} ${file.path}`;
  if (file.action === 'created' || file.action === 'updated') {
    context.ui.success(line);
  } else {
    context.ui.note(line);
  }
}

function report(context: CliContext, outcomes: readonly ShellOutcome[]): void {
  for (const outcome of outcomes) {
    for (const file of outcome.files) reportFile(context, file);
    // The advisory, when a shell has one, belongs beside the files it is
    // about -- see ShellTarget.warnAbout for the case it exists for.
    if (outcome.note !== '') context.ui.warn(outcome.note);
  }
}

/**
 * Refreshes the completions of every shell that already has them, and
 * installs for none that do not.
 *
 * Every entry in `SHELL_TARGETS`, not only the detected ones and not only the
 * one `$SHELL` names: an earlier install may have written into a shell the
 * user has since stopped using, and the stale script left there keeps
 * completing commands that no longer exist. `refresh` itself takes no
 * interest in the environment, so the sweep has to happen here.
 */
export async function refreshCompletions(
  context: CliContext,
  tree: CommandNode,
  env: Record<string, string | undefined> = process.env,
): Promise<readonly ShellOutcome[]> {
  const places = placesFor(context, env);
  const outcomes: ShellOutcome[] = [];
  for (const target of SHELL_TARGETS) {
    const outcome = await refresh(context.fs, target, tree, places);
    if (outcome !== null) outcomes.push(outcome);
  }
  return outcomes;
}

export function registerSelfCompletions(parent: Command, context: CliContext): void {
  const completions = parent
    .command('completions')
    .description('Generate and install shell completions for ailoud');

  completions
    .command('install')
    .description('Write the completion script and wire it into your shell')
    .option('-s, --shell <ids>', `comma-separated shells, or "auto"/"all": ${shellIds()}`)
    .option('-y, --yes', 'no prompt: use the detected shells')
    .action(async (options: Options, command: Command) => {
      await context.ui.frame('Installing completions', async () => {
        const places = placesFor(context);
        const targets = await chooseShells(context, options, places, process.env);
        if (targets.length === 0) {
          context.ui.warn('No shells selected, so nothing was written.');
          context.ui.warn(`Run again with --shell to name one: ${shellIds()}`);
          return;
        }
        const tree = describeTree(rootOf(command));
        const outcomes: ShellOutcome[] = [];
        for (const target of targets) {
          outcomes.push(await install(context.fs, target, tree, places));
        }
        report(context, outcomes);
        context.ui.note('Open a new shell, or source your startup file, to pick them up.');
      });
    });

  completions
    .command('uninstall')
    .description('Remove the completion script and the block it added')
    .option('-s, --shell <ids>', `comma-separated shells, or "auto"/"all" (default): ${shellIds()}`)
    .action(async (options: Options) => {
      await context.ui.frame('Removing completions', async () => {
        const places = placesFor(context);
        const targets = await parseShells(context, options.shell ?? 'all', places, process.env);
        const outcomes: ShellOutcome[] = [];
        for (const target of targets) {
          outcomes.push(await uninstall(context.fs, target, places));
        }
        const touched = outcomes.flatMap((outcome) =>
          outcome.files.filter((file) => file.action === 'removed' || file.action === 'cleaned'),
        );
        if (touched.length === 0) {
          // Said plainly rather than reported as a success: an uninstall that
          // claims to have cleaned files it never touched teaches distrust.
          context.ui.warn('Nothing to remove: no shell here had ailoud completions.');
          return;
        }
        report(context, outcomes);
      });
    });

  completions
    .command('update')
    .description('Refresh completions wherever they are already installed')
    .action(async (_options: unknown, command: Command) => {
      await context.ui.frame('Updating completions', async () => {
        const outcomes = await refreshCompletions(context, describeTree(rootOf(command)));
        if (outcomes.length === 0) {
          context.ui.warn('Nothing to update: no shell here has ailoud completions.');
          context.ui.warn('Run "ailoud self completions install" first.');
          return;
        }
        report(context, outcomes);
      });
    });

  completions
    .command('print')
    .argument('<shell>', `which shell to render for: ${shellIds()}`)
    .description('Write the completion script to stdout without installing it')
    .action(async (shell: string, _options: unknown, command: Command) => {
      const target = findShell(shell);
      if (target === undefined) {
        throw new UsageError(`unknown shell "${shell}"; choose from: ${shellIds()}`);
      }
      // Through content(), never straight to stdout: content() is the channel
      // that stays byte-exact when stdout is redirected, which is the whole
      // point of `ailoud self completions print zsh > _ailoud`.
      context.ui.content(renderCompletions(target.shell as Shell, describeTree(rootOf(command))));
    });
}
