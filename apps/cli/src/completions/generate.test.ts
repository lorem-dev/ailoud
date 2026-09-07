import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { describeTree, renderCompletions } from './generate.js';

function sample(): Command {
  const program = new Command().name('ailoud').description('root');
  const audio = program.command('audio').alias('recordings').description('recordings');
  audio.command('ls').alias('l').description('list them').option('--json', 'as JSON');
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
    expect(ls.options.every((o) => o.startsWith('--'))).toBe(true);
  });
});

describe('renderCompletions', () => {
  it('emits the shape bash needs and names the real commands', () => {
    const script = renderCompletions('bash', describeTree(sample()));
    expect(script).toContain('complete -F _ailoud ailoud');
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

  it('quotes a description safely for every shell', () => {
    // A description with an apostrophe closed the quoting and produced a
    // script that fails to parse -- silently, because nothing sources it
    // until the user opens a new terminal.
    const program = new Command().name('ailoud');
    program.command('x').description("don't break");
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const script = renderCompletions(shell, describeTree(program));
      expect(script).not.toContain("don't break");
    }
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
