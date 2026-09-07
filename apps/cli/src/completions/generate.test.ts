import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { describeTree, renderCompletions } from './generate.js';

function sample(): Command {
  const program = new Command().name('ailoud').description('root');
  const audio = program.command('audio').alias('recordings').description('recordings');
  audio
    .command('ls')
    .alias('l')
    .description('list them')
    .option('--json', 'as JSON')
    // Short-only, so "collects long options" can fail: with `option.flags`
    // instead of `option.long` this would land in the script as `-q, --quiet`
    // -- except there is no long form, so it must not land at all.
    .option('-q', 'quietly');
  // The hidden top-level alias `inGroupAndTopLevel` adds for every verb.
  const hidden = new Command('ls').description('list them');
  program.addCommand(hidden, { hidden: true });
  return program;
}

describe('describeTree', () => {
  it('keeps multi-letter aliases and drops one-letter ones', () => {
    // A completion list is for discovery; a one-letter alias is for someone
    // who already knows it and will not press Tab. Listing both spellings of
    // every verb doubles the list to serve nobody.
    const tree = describeTree(sample());
    const audio = tree.children.find((c) => c.name === 'audio')!;
    expect(audio.aliases).toEqual(['recordings']);
    expect(audio.children.find((c) => c.name === 'ls')!.aliases).toEqual([]);
  });

  it('includes the hidden top-level alias, because it really works', () => {
    // Hidden from --help to keep it readable, but `ailoud ls` is a real
    // invocation. A Tab list that omits it would be wrong about the tool.
    const tree = describeTree(sample());
    expect(tree.children.map((c) => c.name)).toContain('ls');
  });

  it('collects long options and ignores short ones', () => {
    const tree = describeTree(sample());
    const ls = tree.children.find((c) => c.name === 'audio')!.children[0]!;
    expect(ls.options).toContain('--json');
    // `-q` has no long form at all, so nothing about it may reach the script.
    expect(ls.options.every((o) => o.startsWith('--'))).toBe(true);
    expect(ls.options).not.toContain('-q');
    expect(ls.options.join(' ')).not.toContain('quiet');
  });

  it('adds --help and --version to every command, not just the root', () => {
    // Commander answers both at every depth but registers neither in
    // `Command.options` below the root, so without this they appear nowhere:
    // `ailoud audio ls --he<TAB>` completed nothing in real bash.
    const tree = describeTree(sample());
    const ls = tree.children.find((c) => c.name === 'audio')!.children[0]!;
    expect(ls.options).toContain('--help');
    expect(ls.options).toContain('--version');
  });

  it('does not repeat --version at the root, where commander registers it', () => {
    // A duplicate would show twice in the Tab list, and reordering or
    // re-adding on each run would make `update` report a change every time.
    const program = new Command().name('ailoud').version('1.0.0');
    const options = describeTree(program).options;
    expect(options.filter((o) => o === '--version')).toHaveLength(1);
  });
});

describe('renderCompletions', () => {
  it('emits the shape bash needs and names the real commands', () => {
    const script = renderCompletions('bash', describeTree(sample()));
    expect(script).toContain('-F _ailoud ailoud');
    expect(script).toContain('audio');
    expect(script).toContain('recordings');
    expect(script).toContain('--json');
  });

  it('emits the shape zsh needs, with #compdef on the first line', () => {
    // zsh only treats a file in fpath as a completion when its first line
    // is the #compdef tag; anywhere else it is an ordinary comment.
    const script = renderCompletions('zsh', describeTree(sample()));
    expect(script.split('\n')[0]).toBe('#compdef ailoud');
    expect(script).toContain('audio');
  });

  it('never declares a local named "path" in zsh, which is tied to $PATH', () => {
    // zsh links the array `path` to the scalar `PATH`. `local path=""` empties
    // $PATH for the whole completion call -- verified in zsh 5.9, where the
    // function saw `PATH=audio import` while completing `ailoud audio import`.
    // Every external command run from the function, and every autoloaded
    // helper that runs one, then fails with "command not found" and Tab
    // silently returns nothing.
    const script = renderCompletions('zsh', describeTree(sample()));
    expect(script).not.toMatch(/\blocal\b[^\n]*\bpath=/);
    expect(script).not.toMatch(/\$\{?path\b/);
  });

  it('emits the shape fish needs, with descriptions', () => {
    const script = renderCompletions('fish', describeTree(sample()));
    expect(script).toContain('complete -c ailoud');
    expect(script).toContain('recordings');
    expect(script).toContain('list them');
  });

  it('escapes an apostrophe in the fish description, the only shell that emits one', () => {
    // A description with an apostrophe closed the quoting and produced a
    // script that fails to parse -- silently, because nothing sources it
    // until the user opens a new terminal.
    //
    // fish only: bash and zsh emit no descriptions at all, so asserting the
    // raw string is absent from those two passed for the wrong reason. What
    // matters is not that the raw form is missing but that the escaped form
    // is present, since an implementation that dropped the description
    // entirely would also satisfy "does not contain".
    const program = new Command().name('ailoud');
    program.command('x').description("don't break");
    const fish = renderCompletions('fish', describeTree(program));
    expect(fish).toContain("-d 'don'\\''t break'");
    expect(fish).not.toContain("-d 'don't break'");
  });

  it('leaves filename completion working in every shell', () => {
    // Installing completions REMOVED filename completion. Verified in bash
    // 3.2: before installing, `ailoud audio import fx/<TAB>` listed the media
    // files; after, it rang the bell twice and offered nothing. `complete -F`
    // alone tells bash the function is the whole answer, fish's `-f` says the
    // command takes no file at all, and the zsh function never reached
    // `_files`. `import` and `transcribe` are the commands users type most.
    const tree = describeTree(sample());
    expect(renderCompletions('bash', tree)).toContain('complete -o default -o bashdefault -F');
    expect(renderCompletions('zsh', tree)).toContain('_files');
    expect(renderCompletions('fish', tree)).not.toContain('complete -c ailoud -f\n');
  });

  it('offers options only once the word starts with a dash', () => {
    // One merged candidate list meant `ailoud audio import <TAB>` answered
    // with the option names, so the fallback to files above was never
    // reached for the empty word -- which is how that argument is usually
    // typed.
    const bash = renderCompletions('bash', describeTree(sample()));
    expect(bash).toContain('-*) COMPREPLY=( $(compgen -W "$opts" -- "$cur") ) ;;');
    expect(bash).toContain('*) COMPREPLY=( $(compgen -W "$subs" -- "$cur") ) ;;');
    // A leaf: no subcommand of its own, so an empty word falls through to the
    // filename completion `-o default` restores.
    expect(bash).toContain('subs=""; opts="--json --help --version"');
    expect(bash).toContain('subs="audio recordings ls"; opts="--help --version"');

    const zsh = renderCompletions('zsh', describeTree(sample()));
    expect(zsh).toContain('if [[ $cur == -* ]]; then');
    expect(zsh).toContain('compadd -- ${=subs} || _files');
  });

  it('emits options for fish too, not subcommands only', () => {
    // fish was the only shell that emitted no options at all: `ailoud audio
    // ls --<TAB>` offered nothing there while bash offered `--json --tag`.
    // The design draws no distinction between the shells.
    const script = renderCompletions('fish', describeTree(sample()));
    const lsOptions = script
      .split('\n')
      .filter((line) => line.includes('__fish_seen_subcommand_from ls') && line.includes(' -l '));
    expect(lsOptions.some((line) => line.endsWith('-l json'))).toBe(true);
    expect(lsOptions.some((line) => line.endsWith('-l help'))).toBe(true);
    // `-l name`, never `-a '--name'`: only `-l` tells fish the word is a long
    // option, which is what makes it complete after a bare `--`.
    expect(script).not.toContain("-a '--json'");
  });

  it('routes through an alias, not only past it', () => {
    // `recordings` was offered as a candidate and then completed nothing:
    // verified in real bash, where `ailoud recordings <TAB>` produced two
    // bells and no list. Offering a word and then having nothing follow it is
    // worse than never offering it.
    const tree = describeTree(sample());
    expect(renderCompletions('bash', tree)).toContain('"recordings")');
    expect(renderCompletions('zsh', tree)).toContain('"recordings")');
    expect(renderCompletions('fish', tree)).toContain(
      "__fish_seen_subcommand_from recordings' -a 'ls'",
    );
  });

  it('produces the same bytes for the same tree', () => {
    // `update` compares before and after to report "unchanged"; a generator
    // that reorders its own output would rewrite the file on every run.
    const a = renderCompletions('bash', describeTree(sample()));
    const b = renderCompletions('bash', describeTree(sample()));
    expect(a).toBe(b);
  });

  it('gives fish one condition per ancestor, so two parents nesting the same child name stay distinct', () => {
    // `self completions` and `other completions` both nest a subcommand
    // named `completions`. A condition that named only the immediate parent
    // would read `__fish_seen_subcommand_from completions` for both, so
    // `ailoud other completions <TAB>` would offer `self completions`'s
    // children (`install`, `uninstall`) alongside its own (`foo`).
    const program = new Command().name('ailoud');
    const self = program.command('self').description('self management');
    const selfCompletions = self.command('completions').description('shell completions');
    selfCompletions.command('install').description('install them');
    selfCompletions.command('uninstall').description('remove them');
    const other = program.command('other').description('other things');
    const otherCompletions = other.command('completions').description('other completions');
    otherCompletions.command('foo').description('do foo');

    const script = renderCompletions('fish', describeTree(program));
    const lines = script.split('\n');
    const conditionsFor = (name: string): string => {
      const line = lines.find((l) => l.includes(`-a '${name}'`));
      expect(line).toBeDefined();
      return line!.slice(0, line!.indexOf(" -a '"));
    };

    const install = conditionsFor('install');
    const foo = conditionsFor('foo');
    expect(install).not.toBe(foo);
    expect(install).toContain('__fish_seen_subcommand_from self');
    expect(foo).toContain('__fish_seen_subcommand_from other');
  });
});
