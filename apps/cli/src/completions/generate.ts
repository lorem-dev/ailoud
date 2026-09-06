import type { Command } from 'commander';

export type Shell = 'bash' | 'zsh' | 'fish';

/**
 * The shells ailoud can install completions for.
 *
 * `ash`, `dash` and a bare `sh` are absent deliberately: they have no
 * programmable completion at all, so there is no script to install. Writing
 * a file nothing reads looks exactly like a successful install, and the user
 * only finds out when Tab does nothing.
 */
export const SHELLS: readonly Shell[] = ['bash', 'zsh', 'fish'];

/** One command in the tree, reduced to what a completion script needs. */
export interface CommandNode {
  readonly name: string;
  readonly description: string;
  /** Multi-letter aliases only. */
  readonly aliases: readonly string[];
  /** Long option flags, e.g. `--json`. */
  readonly options: readonly string[];
  readonly children: readonly CommandNode[];
}

/**
 * The command tree, reduced to what a completion script needs.
 *
 * Read off the live commander tree rather than a list kept beside it. A
 * second statement of what the commands are goes stale: this project's own
 * AGENTS.md records a command table that said `search` and `summarize` "do
 * not exist yet" long after both shipped.
 *
 * One-letter aliases are dropped -- see the test for why. Hidden commands
 * are kept: `inGroupAndTopLevel` hides the top-level spelling of every verb
 * from `--help` to keep that readable, but `ailoud ls` is a real invocation
 * and a Tab list that omitted it would be wrong about what works.
 */
export function describeTree(command: Command): CommandNode {
  return {
    name: command.name(),
    description: command.description(),
    aliases: command.aliases().filter((alias) => alias.length > 1),
    options: command.options
      .map((option) => option.long)
      .filter((long): long is string => typeof long === 'string'),
    children: command.commands.map(describeTree),
  };
}

/** One command path, with the words that complete it. */
interface PathEntry {
  readonly path: readonly string[];
  readonly words: readonly string[];
  readonly node: CommandNode;
}

/** Every command path, with the words that follow it. Depth-first, stable order. */
function paths(node: CommandNode, prefix: readonly string[] = []): PathEntry[] {
  const words: readonly string[] = [
    ...node.children.flatMap((child) => [child.name, ...child.aliases]),
    ...node.options,
  ];
  const here: PathEntry[] = [{ path: prefix, words, node }];
  return here.concat(node.children.flatMap((child) => paths(child, [...prefix, child.name])));
}

/**
 * A description, safe to sit inside single quotes in any of the three shells.
 *
 * An apostrophe in a description closed the quoting and produced a script
 * that fails to parse -- silently, because nothing sources it until the user
 * opens a new terminal.
 */
function quote(text: string): string {
  return text.replace(/'/g, "'\\''");
}

function renderBash(tree: CommandNode): string {
  const cases = paths(tree)
    .map(
      ({ path, words }) =>
        `    ${path.length === 0 ? '""' : `"${path.join(' ')}"`})\n      words="${words.join(' ')}" ;;`,
    )
    .join('\n');
  return [
    '_ailoud() {',
    '  local cur path i words',
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    '  path=""',
    '  for (( i=1; i < COMP_CWORD; i++ )); do',
    '    case "${COMP_WORDS[i]}" in -*) continue ;; esac',
    '    path="${path:+$path }${COMP_WORDS[i]}"',
    '  done',
    '  words=""',
    '  case "$path" in',
    cases,
    '  esac',
    '  COMPREPLY=( $(compgen -W "$words" -- "$cur") )',
    '}',
    'complete -F _ailoud ailoud',
    '',
  ].join('\n');
}

function renderZsh(tree: CommandNode): string {
  const cases = paths(tree)
    .map(
      ({ path, words }) =>
        `    ${path.length === 0 ? '""' : `"${path.join(' ')}"`})\n      candidates="${words.join(' ')}" ;;`,
    )
    .join('\n');
  return [
    '#compdef ailoud',
    '_ailoud() {',
    '  local path="" candidates="" i',
    '  for (( i = 2; i < CURRENT; i++ )); do',
    '    [[ ${words[i]} == -* ]] && continue',
    '    path="${path:+$path }${words[i]}"',
    '  done',
    '  case "$path" in',
    cases,
    '  esac',
    '  compadd -- ${=candidates}',
    '}',
    '_ailoud "$@"',
    '',
  ].join('\n');
}

function renderFish(tree: CommandNode): string {
  const lines = ['complete -c ailoud -f'];
  for (const { path, node } of paths(tree)) {
    for (const child of node.children) {
      const condition =
        path.length === 0
          ? '__fish_use_subcommand'
          : `__fish_seen_subcommand_from ${path[path.length - 1]}`;
      for (const name of [child.name, ...child.aliases]) {
        lines.push(
          `complete -c ailoud -n '${condition}' -a '${name}' -d '${quote(child.description)}'`,
        );
      }
    }
  }
  lines.push('');
  return lines.join('\n');
}

export function renderCompletions(shell: Shell, tree: CommandNode): string {
  switch (shell) {
    case 'bash':
      return renderBash(tree);
    case 'zsh':
      return renderZsh(tree);
    case 'fish':
      return renderFish(tree);
  }
}
