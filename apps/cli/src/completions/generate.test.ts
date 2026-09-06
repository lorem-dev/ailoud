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
});
