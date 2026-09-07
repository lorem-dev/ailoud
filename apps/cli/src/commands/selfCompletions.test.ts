import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { MemFs } from '@ailoud/core/testing';
import { UsageError } from '@ailoud/core';
import type { CliContext } from '../wiring.js';
import type { CommandNode } from '../completions/generate.js';
import { install } from '../completions/install.js';
import { findShell } from '../completions/shells.js';
import {
  parseShells,
  refreshCompletions,
  registerSelfCompletions,
  rootOf,
} from './selfCompletions.js';

const HOME = '/home/ann';
const CONFIG = '/home/ann/.config';
const DATA = '/home/ann/.local/share/ailoud';
const PLACES = { home: HOME, configHome: CONFIG, userDataDir: DATA };

// Mocked module-wide so the "--yes" test below can assert the prompt was
// never reached, rather than hoping a real terminal-less multiselect() call
// fails loudly instead of hanging the test runner.
const clack = vi.hoisted(() => ({
  multiselect: vi.fn(async () => {
    throw new Error('multiselect must not be called when --yes is set');
  }),
  isCancel: vi.fn(() => false),
}));
vi.mock('@clack/prompts', () => clack);

/** What each ui channel was called with, and nothing else -- see mcpInstall.test.ts's uiSpy. */
interface UiCalls {
  readonly content: string[];
  readonly success: string[];
  readonly warn: string[];
  readonly note: string[];
}

/** A context whose `ui` records which channel each line went to, over the real fs and paths. */
function contextWithUi(fs: MemFs): { context: CliContext; calls: UiCalls } {
  const calls: UiCalls = { content: [], success: [], warn: [], note: [] };
  const context = {
    fs,
    paths: { configHome: CONFIG, userDataDir: DATA },
    ui: {
      content: (text: string): void => {
        calls.content.push(text);
      },
      success: (text: string): void => {
        calls.success.push(text);
      },
      warn: (text: string): void => {
        calls.warn.push(text);
      },
      note: (text: string): void => {
        calls.note.push(text);
      },
      frame: async <T>(_label: string, task: () => Promise<T>): Promise<T> => task(),
    },
  } as unknown as CliContext;
  return { context, calls };
}

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

describe('registerSelfCompletions: print', () => {
  it('writes the script through content(), and touches no file', async () => {
    const fs = new MemFs({});
    const { context, calls } = contextWithUi(fs);
    const program = new Command().name('ailoud');
    registerSelfCompletions(program, context);

    await program.parseAsync(['node', 'ailoud', 'completions', 'print', 'zsh']);

    // content() is the channel that stays byte-exact when stdout is
    // redirected -- the whole point of `ailoud self completions print zsh >
    // _ailoud`. A regression that routed this through note() or success()
    // instead would look identical on a terminal (PlainUi renders both with
    // no prefix) and only break the moment the output is piped, which a
    // terminal-only test run could never catch.
    expect(calls.content).toHaveLength(1);
    expect(calls.content[0]).toContain('#compdef ailoud');
    expect(calls.success).toEqual([]);
    expect(calls.warn).toEqual([]);
    expect(calls.note).toEqual([]);

    // No install side effect: print only ever renders, it never writes.
    expect(await fs.exists(`${DATA}/completions/_ailoud`)).toBe(false);
    expect(await fs.exists(`${HOME}/.zshrc`)).toBe(false);
  });
});

describe('registerSelfCompletions: install --yes', () => {
  it('resolves to the detected shells without prompting', async () => {
    // Forces chooseShells' interactive branch open (a real terminal, no CI),
    // so the only thing that can be stopping the prompt is --yes itself --
    // without this, the non-interactive fallback would take the same path
    // for the wrong reason and the test would pass even if --yes did nothing.
    const isTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const originalCi = process.env['CI'];
    const originalHome = process.env['HOME'];
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    delete process.env['CI'];
    process.env['HOME'] = HOME;
    try {
      const fs = new MemFs({ [`${HOME}/.zshrc`]: '' });
      const { context } = contextWithUi(fs);
      const program = new Command().name('ailoud');
      registerSelfCompletions(program, context);

      await program.parseAsync(['node', 'ailoud', 'completions', 'install', '--yes']);

      expect(clack.multiselect).not.toHaveBeenCalled();
      expect(await fs.exists(`${DATA}/completions/_ailoud`)).toBe(true);
      expect(await fs.exists(`${DATA}/completions/ailoud.bash`)).toBe(false);
      expect(await fs.exists(`${CONFIG}/fish/completions/ailoud.fish`)).toBe(false);
    } finally {
      if (isTtyDescriptor === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
      else Object.defineProperty(process.stdin, 'isTTY', isTtyDescriptor);
      if (originalCi === undefined) delete process.env['CI'];
      else process.env['CI'] = originalCi;
      if (originalHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = originalHome;
    }
  });
});

describe('registerSelfCompletions: install --shell fish', () => {
  it('reports only one file for a shell with no rc requirement', async () => {
    const fs = new MemFs({});
    const { context, calls } = contextWithUi(fs);
    const program = new Command().name('ailoud');
    registerSelfCompletions(program, context);

    await program.parseAsync(['node', 'ailoud', 'completions', 'install', '--shell', 'fish']);

    // fish has no rcPath (see SHELL_TARGETS in completions/shells.ts): install()
    // pushes only the script's own FileOutcome for it, never a second one for
    // a startup file fish does not have. A regression that assumed every
    // shell needs an rc file would report two lines here instead of one.
    expect(calls.success).toHaveLength(1);
    expect(calls.success[0]).toContain(`${CONFIG}/fish/completions/ailoud.fish`);
    expect(await fs.exists(`${CONFIG}/fish/completions/ailoud.fish`)).toBe(true);
  });
});
