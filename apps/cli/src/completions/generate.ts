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
 * The two options commander answers on every command in the tree, at every
 * depth, without registering either in `Command.options`.
 *
 * They therefore have to be added here or they appear nowhere: before this,
 * `ailoud audio ls --he<TAB>` completed nothing, and `--version` showed up
 * only at the root, where commander does put it in `options`. Both really do
 * work everywhere -- `ailoud audio ls --version` prints the version and
 * `ailoud audio ls --help` prints that command's help -- so listing them is
 * not a completion promising an invocation that fails.
 */
const GLOBAL_OPTIONS: readonly string[] = ['--help', '--version'];

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
  // `option.long`, not `option.flags`: `flags` is the whole registration
  // string, so `-t, --tag <tag>` would go into the script verbatim and offer
  // a candidate no shell can complete to.
  const longs = command.options
    .map((option) => option.long)
    .filter((long): long is string => typeof long === 'string');
  return {
    name: command.name(),
    description: command.description(),
    aliases: command.aliases().filter((alias) => alias.length > 1),
    // Appended, and only when missing, so the root -- where commander does
    // register `--version` -- keeps one copy and the order stays stable
    // across runs, which is what lets `update` report "unchanged".
    options: [...longs, ...GLOBAL_OPTIONS.filter((global) => !longs.includes(global))],
    children: command.commands.map(describeTree),
  };
}

/**
 * One command path, with the words that complete it.
 *
 * Subcommands and options are kept apart rather than merged into one list
 * because the shells offer them at different moments: a word starting with
 * `-` is being completed as an option, anything else as a subcommand. Merging
 * them is what made `ailoud audio import <TAB>` answer with five option names
 * where the user wanted a file.
 */
interface PathEntry {
  readonly path: readonly string[];
  /** Subcommand names, each spelling of them. */
  readonly subs: readonly string[];
  /** Long option flags, e.g. `--json`. */
  readonly opts: readonly string[];
  readonly node: CommandNode;
}

/**
 * Every command path, with the words that follow it. Depth-first, stable order.
 *
 * Recursed once per SPELLING of each child, not once per canonical name. The
 * aliases are already offered as candidates -- the design lists the group
 * plurals as "words a user types and might Tab" -- and descending only through
 * canonical names meant `ailoud recordings <TAB>` matched no case arm and
 * completed nothing in all three shells. Offering a word and then completing
 * nothing after it is worse than never offering it.
 *
 * The duplication this costs is bounded by the aliases that survive
 * `describeTree`: three group plurals, each on a leaf-bearing group. One-letter
 * aliases are already dropped there, which is what keeps this from doubling
 * every verb.
 */
function paths(node: CommandNode, prefix: readonly string[] = []): PathEntry[] {
  const subs = node.children.flatMap((child) => [child.name, ...child.aliases]);
  const here: PathEntry[] = [{ path: prefix, subs, opts: node.options, node }];
  return here.concat(
    node.children.flatMap((child) =>
      [child.name, ...child.aliases].flatMap((spelling) => paths(child, [...prefix, spelling])),
    ),
  );
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

/** The `case` label for one command path: the empty path is the bare `ailoud`. */
function caseLabel(path: readonly string[]): string {
  return path.length === 0 ? '""' : `"${path.join(' ')}"`;
}

function renderBash(tree: CommandNode): string {
  const cases = paths(tree)
    .map(
      ({ path, subs, opts }) =>
        `    ${caseLabel(path)})\n      subs="${subs.join(' ')}"; opts="${opts.join(' ')}" ;;`,
    )
    .join('\n');
  return [
    '_ailoud() {',
    '  local cur path i subs opts',
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    '  path=""',
    '  for (( i=1; i < COMP_CWORD; i++ )); do',
    '    case "${COMP_WORDS[i]}" in -*) continue ;; esac',
    '    path="${path:+$path }${COMP_WORDS[i]}"',
    '  done',
    '  subs=""',
    '  opts=""',
    '  case "$path" in',
    cases,
    '  esac',
    // Options only while the word being completed already starts with `-`.
    // Merging them into one list meant `ailoud audio import <TAB>` answered
    // with the option names and nothing else, where the argument the user is
    // actually typing is a media file.
    '  case "$cur" in',
    '    -*) COMPREPLY=( $(compgen -W "$opts" -- "$cur") ) ;;',
    '    *) COMPREPLY=( $(compgen -W "$subs" -- "$cur") ) ;;',
    '  esac',
    '}',
    // `-o default -o bashdefault`, without which installing completions REMOVED
    // filename completion: `complete -F` alone tells bash the function is the
    // whole answer, so an empty COMPREPLY means "no completions" rather than
    // "fall back". Verified in bash 3.2 -- before installing, `ailoud audio
    // import fx/<TAB>` listed the media files; after, it rang the bell twice.
    // `import` and `transcribe` are the commands users type most, so a
    // completion feature that breaks paths for them is worse than none.
    'complete -o default -o bashdefault -F _ailoud ailoud',
    '',
  ].join('\n');
}

function renderZsh(tree: CommandNode): string {
  const cases = paths(tree)
    .map(
      ({ path, subs, opts }) =>
        `    ${caseLabel(path)})\n      subs="${subs.join(' ')}"; opts="${opts.join(' ')}" ;;`,
    )
    .join('\n');
  return [
    '#compdef ailoud',
    '_ailoud() {',
    // `_path`, never `path`: zsh ties the array `path` to the scalar `PATH`,
    // so `local path=""` empties `$PATH` for the whole call and it ends up
    // holding the words being completed. Verified in zsh 5.9: during `ailoud
    // audio import <TAB>` the function saw `PATH=audio import`, and `date`
    // run from inside it failed with "command not found". `_files` below is
    // exactly the kind of helper that would have died there.
    '  local _path="" subs="" opts="" cur i',
    '  for (( i = 2; i < CURRENT; i++ )); do',
    '    [[ ${words[i]} == -* ]] && continue',
    '    _path="${_path:+$_path }${words[i]}"',
    '  done',
    '  cur="${words[CURRENT]}"',
    '  case "$_path" in',
    cases,
    '  esac',
    // Same split as bash, and the same fallback: `_files` only once `compadd`
    // has reported that it matched nothing, so `ailoud <TAB>` still lists the
    // commands alone instead of every file in the directory.
    '  if [[ $cur == -* ]]; then',
    '    compadd -- ${=opts}',
    '  else',
    '    compadd -- ${=subs} || _files',
    '  fi',
    '}',
    '_ailoud "$@"',
    '',
  ].join('\n');
}

function renderFish(tree: CommandNode): string {
  // No `complete -c ailoud -f`. That line said "this command never takes a
  // file", which is how fish's half of the same defect bash had appeared:
  // `ailoud audio import <TAB>` stopped offering media files the moment the
  // completions were installed. Without it fish keeps its own filename
  // completion alongside ours, which is what the user had before installing.
  const lines: string[] = [];
  for (const { path, node } of paths(tree)) {
    // Fish ANDs multiple `-n` flags, so a completion three levels deep
    // needs one flag per ancestor segment, not just the last. Naming only
    // the last segment let two unrelated parents that both nest a
    // same-named child -- `self completions` and `other completions` --
    // share one condition, so `ailoud other completions <TAB>` offered
    // `self completions`'s children too.
    //
    // The same condition covers this node's own options: reaching them means
    // having typed the same segments that reaching its children does.
    const flags =
      path.length === 0
        ? "-n '__fish_use_subcommand'"
        : path.map((segment) => `-n '__fish_seen_subcommand_from ${segment}'`).join(' ');
    for (const child of node.children) {
      for (const name of [child.name, ...child.aliases]) {
        lines.push(`complete -c ailoud ${flags} -a '${name}' -d '${quote(child.description)}'`);
      }
    }
    // Options too, which fish alone was missing: bash and zsh both put
    // `node.options` in their candidate list, so `ailoud audio ls --<TAB>`
    // offered `--json --tag` there and nothing at all in fish. The design
    // draws no distinction between the shells here.
    //
    // `-l <name>` rather than `-a '--name'`: it is how fish is told a word is
    // a long option, which is what makes it complete after a bare `--` and
    // keeps it out of the argument list.
    for (const option of node.options) {
      lines.push(`complete -c ailoud ${flags} -l ${option.replace(/^--/, '')}`);
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
