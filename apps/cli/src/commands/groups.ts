import { Command } from 'commander';
import type { CliContext } from '../wiring.js';

/** How every command in this codebase is registered: onto a parent, with the context. */
export type Register = (parent: Command, context: CliContext) => void;

/**
 * Creates a noun group -- `laud audio ...`, `laud report ...`.
 *
 * Singular canonical name with the plural as an alias, following the
 * convention every tool with groups already uses (`docker container ls`,
 * `gh pr list`, `kubectl get pod`): `laud report rm SUM0` reads as removing one
 * report, while `laud reports rm SUM0` reads as removing all of them.
 *
 * `showHelpAfterError` and the help-on-empty behaviour matter here: `laud
 * audio` on its own is someone who does not yet know the verbs, and printing
 * the list is the answer to that, where an error is not.
 */
export function group(
  program: Command,
  name: string,
  plural: string,
  description: string,
): Command {
  return program
    .command(name)
    .alias(plural)
    .description(description)
    .showHelpAfterError()
    .action(function (this: Command) {
      this.help();
    });
}

/**
 * Registers a command inside its group, and again at the top level as a
 * hidden alias.
 *
 * The alias is not legacy debt to be removed later; it is the same bargain
 * docker struck and kept. `docker ps` still works years after `docker
 * container ls` became the canonical spelling, because the short form is what
 * people's hands and scripts already know. Hidden rather than listed, so the
 * top-level help shows the shape of the tool -- verbs that create things, and
 * two nouns -- instead of every command twice.
 *
 * Registered twice rather than shared: a commander Command belongs to one
 * parent, so the two spellings are two objects driving the same action. The
 * register function is the single definition of that action, which is what
 * keeps them from drifting.
 */
export function inGroupAndTopLevel(
  program: Command,
  parent: Command,
  register: Register,
  context: CliContext,
): void {
  register(parent, context);

  const holder = new Command();
  register(holder, context);
  const [aliased] = holder.commands;
  if (aliased !== undefined) program.addCommand(aliased, { hidden: true });
}
