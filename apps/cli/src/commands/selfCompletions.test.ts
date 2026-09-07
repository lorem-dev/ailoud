import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { MemFs } from '@ailoud/core/testing';
import { UsageError } from '@ailoud/core';
import type { CliContext } from '../wiring.js';
import type { CommandNode } from '../completions/generate.js';
import { install } from '../completions/install.js';
import { findShell } from '../completions/shells.js';
import { parseShells, refreshCompletions, rootOf } from './selfCompletions.js';

const HOME = '/home/ann';
const CONFIG = '/home/ann/.config';
const DATA = '/home/ann/.local/share/ailoud';
const PLACES = { home: HOME, configHome: CONFIG, userDataDir: DATA };

const TREE: CommandNode = {
  name: 'ailoud',
  description: 'root',
  aliases: [],
  options: [],
  children: [{ name: 'ls', description: 'list', aliases: [], options: [], children: [] }],
};

/** Only `fs` and `paths` are reached by the functions under test. */
function contextWith(fs: MemFs): CliContext {
  return { fs, paths: { configHome: CONFIG, userDataDir: DATA } } as unknown as CliContext;
}

describe('rootOf', () => {
  it('walks up to the root from a command nested two deep', () => {
    // The completion script must describe the whole tree, and an action only
    // ever holds its own command. Building a second program instead would
    // open the database for a script that does not need a library.
    const program = new Command().name('ailoud');
    const group = program.command('self');
    const leaf = group.command('completions');
    expect(rootOf(leaf).name()).toBe('ailoud');
    expect(rootOf(program).name()).toBe('ailoud');
  });
});

describe('parseShells', () => {
  const context = contextWith(new MemFs({}));

  it('takes a comma-separated list', async () => {
    const targets = await parseShells(context, 'bash,fish', PLACES, {});
    expect(targets.map((t) => t.shell)).toEqual(['bash', 'fish']);
  });

  it('names the valid shells when given one that does not exist', async () => {
    // ash and dash land here: they have no programmable completion at all, so
    // there is nothing to install and saying so beats writing a dead file.
    await expect(parseShells(context, 'ash', PLACES, {})).rejects.toBeInstanceOf(UsageError);
    await expect(parseShells(context, 'ash', PLACES, {})).rejects.toThrow(/bash, zsh, fish/);
  });

  it('resolves "auto" to the detected shells only', async () => {
    const fs = new MemFs({ [`${HOME}/.zshrc`]: '' });
    const targets = await parseShells(contextWith(fs), 'auto', PLACES, {});
    expect(targets.map((t) => t.shell)).toEqual(['zsh']);
  });

  it('resolves "all" without looking at the machine', async () => {
    const targets = await parseShells(context, 'all', PLACES, {});
    expect(targets.map((t) => t.shell)).toEqual(['bash', 'zsh', 'fish']);
  });
});

describe('refreshCompletions', () => {
  it('returns nothing when no shell has completions installed', async () => {
    const fs = new MemFs({ [`${HOME}/.bashrc`]: 'export PATH=x\n' });
    expect(await refreshCompletions(contextWith(fs), TREE, { HOME: HOME })).toEqual([]);
    expect(await fs.exists(`${DATA}/completions/ailoud.bash`)).toBe(false);
  });

  it('sweeps a shell the user does not run, and skips one with nothing installed', async () => {
    // The sweep must not be limited to the detected shells or to $SHELL: an
    // earlier install may have written into a shell since abandoned, where a
    // stale script keeps completing commands that no longer exist.
    const fs = new MemFs({});
    await install(fs, findShell('zsh')!, TREE, PLACES);
    await fs.writeTextFile(`${DATA}/completions/_ailoud`, '# stale\n');

    const outcomes = await refreshCompletions(contextWith(fs), TREE, { HOME: HOME });

    expect(outcomes.map((o) => o.shell)).toEqual(['zsh']);
    expect(await fs.readTextFile(`${DATA}/completions/_ailoud`)).not.toContain('stale');
    expect(await fs.exists(`${DATA}/completions/ailoud.bash`)).toBe(false);
    expect(await fs.exists(`${CONFIG}/fish/completions/ailoud.fish`)).toBe(false);
  });
});
