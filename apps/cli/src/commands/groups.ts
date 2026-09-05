import { Command } from 'commander';
import type { CliContext } from '../wiring.js';

/** How every command in this codebase is registered: onto a parent, with the context. */
export type Register = (parent: Command, context: CliContext) => void;

/**
 * Creates a noun group -- `ailoud audio ...`, `ailoud report ...`.
 *
 * Singular canonical name with the plural as an alias, following the
 * convention every tool with groups already uses (`docker container ls`,
 * `gh pr list`, `kubectl get pod`): `ailoud report rm SUM0` reads as removing one
 * report, while `ailoud reports rm SUM0` reads as removing all of them.
 *
 * `showHelpAfterError` and the help-on-empty behaviour matter here: `ailoud
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

/**
 * The one-letter alias for each second-level verb.
 *
 * One table rather than a letter beside each command definition, because the
 * risk here is collision and a table is where you can see it: every letter
 * below appears exactly once, and the test for that reads this map.
 *
 * The same verb gets the same letter in every group -- `l` lists, `v` views,
 * `r` removes -- so the letters are worth learning once instead of per noun.
 * `v` for `show` rather than `s`: `s` belongs to `summarize`, which is a thing
 * people run, where `show` is closer to `gh pr view` anyway.
 */
const LETTER: Record<string, string> = {
  ls: 'l',
  show: 'v',
  annotate: 'a',
  rm: 'r',
  import: 'i',
  transcribe: 't',
  summarize: 's',
  // `new` rather than `add`, so `n` does not compete with a verb that exists.
  new: 'n',
  // `f` for find: `s` is summarize, and search is the verb people reach for
  // most often after `ls`.
  search: 'f',
};

/** Every letter this build assigns, for the collision test to read. */
export const SECOND_LEVEL_LETTERS: Readonly<Record<string, string>> = LETTER;

/**
 * Attaches the one-letter aliases to a group's verbs.
 *
 * Applied after registration rather than inside each command, so the letters
 * stay in the table above. A verb with no entry simply has no letter, which is
 * the right default for anything added later without a considered one.
 */
export function attachLetters(group: Command): void {
  for (const command of group.commands) {
    const letter = LETTER[command.name()];
    if (letter !== undefined) command.alias(letter);
  }
}
