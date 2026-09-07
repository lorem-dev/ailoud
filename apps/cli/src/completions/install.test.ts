import { describe, expect, it } from 'vitest';
import { MemFs } from '@ailoud/core/testing';
import type { CommandNode } from './generate.js';
import { START, install, refresh, uninstall } from './install.js';
import { findShell } from './shells.js';

const HOME = '/home/ann';
const CONFIG = '/home/ann/.config';
const DATA = '/home/ann/.local/share/ailoud';
const PLACES = { home: HOME, configHome: CONFIG, userDataDir: DATA };

const TREE: CommandNode = {
  name: 'ailoud',
  description: 'root',
  aliases: [],
  options: ['--json'],
  children: [{ name: 'ls', description: 'list', aliases: [], options: [], children: [] }],
};

const actions = (files: readonly { path: string; action: string }[]) =>
  Object.fromEntries(files.map((file) => [file.path, file.action]));

describe('install', () => {
  it('writes the bash script and adds the block to .bashrc, leaving a hand-written line alone', async () => {
    const fs = new MemFs({ [`${HOME}/.bashrc`]: 'export PATH="$PATH:/opt/tool/bin"\n' });
    const bash = findShell('bash')!;
    const outcome = await install(fs, bash, TREE, PLACES);
    const byPath = actions(outcome.files);
    expect(byPath[`${DATA}/completions/ailoud.bash`]).toBe('created');
    expect(byPath[`${HOME}/.bashrc`]).toBe('updated');
    const rc = await fs.readTextFile(`${HOME}/.bashrc`);
    expect(rc).toContain('export PATH="$PATH:/opt/tool/bin"');
    expect(rc).toContain(START);
    expect(await fs.readTextFile(`${DATA}/completions/ailoud.bash`)).toContain('_ailoud');
  });

  it('reports unchanged for both files on a second run', async () => {
    const fs = new MemFs({});
    const bash = findShell('bash')!;
    await install(fs, bash, TREE, PLACES);
    const second = await install(fs, bash, TREE, PLACES);
    expect(Object.values(actions(second.files))).toEqual(['unchanged', 'unchanged']);
  });

  it('writes only the script for fish, with no rc outcome at all', async () => {
    const fs = new MemFs({});
    const fish = findShell('fish')!;
    const outcome = await install(fs, fish, TREE, PLACES);
    expect(outcome.files).toHaveLength(1);
    expect(outcome.files[0]!.path).toBe(`${CONFIG}/fish/completions/ailoud.fish`);
    expect(outcome.files[0]!.action).toBe('created');
  });

  it('returns a non-empty note when .bash_profile exists and never sources .bashrc', async () => {
    const fs = new MemFs({
      [`${HOME}/.bash_profile`]: 'export PATH="$PATH:/opt/tool/bin"\n',
    });
    const bash = findShell('bash')!;
    const outcome = await install(fs, bash, TREE, PLACES);
    expect(outcome.note).toContain('.bash_profile');
  });

  it('returns an empty note when there is no .bash_profile to warn about', async () => {
    const fs = new MemFs({});
    const bash = findShell('bash')!;
    const outcome = await install(fs, bash, TREE, PLACES);
    expect(outcome.note).toBe('');
  });
});

describe('uninstall', () => {
  it('removes the block and deletes the script, leaving a hand-written line untouched', async () => {
    const fs = new MemFs({ [`${HOME}/.bashrc`]: 'export PATH="$PATH:/opt/tool/bin"\n' });
    const bash = findShell('bash')!;
    await install(fs, bash, TREE, PLACES);

    const outcome = await uninstall(fs, bash, PLACES);
    const byPath = actions(outcome.files);
    expect(byPath[`${DATA}/completions/ailoud.bash`]).toBe('removed');
    expect(byPath[`${HOME}/.bashrc`]).toBe('cleaned');
    expect(await fs.exists(`${DATA}/completions/ailoud.bash`)).toBe(false);
    const rc = await fs.readTextFile(`${HOME}/.bashrc`);
    expect(rc).toContain('export PATH="$PATH:/opt/tool/bin"');
    expect(rc).not.toContain(START);
  });

  it('reports absent, not unchanged as a claimed clean, for a .bashrc that never had a block', async () => {
    const fs = new MemFs({ [`${HOME}/.bashrc`]: 'export PATH="$PATH:/opt/tool/bin"\n' });
    const bash = findShell('bash')!;
    const outcome = await uninstall(fs, bash, PLACES);
    const byPath = actions(outcome.files);
    expect(byPath[`${DATA}/completions/ailoud.bash`]).toBe('absent');
    expect(byPath[`${HOME}/.bashrc`]).toBe('unchanged');
  });

  it('reports absent for a .bashrc that does not exist at all', async () => {
    const fs = new MemFs({});
    const bash = findShell('bash')!;
    const outcome = await uninstall(fs, bash, PLACES);
    expect(actions(outcome.files)[`${HOME}/.bashrc`]).toBe('absent');
  });

  it('preserves .bashrc that was empty before install: after uninstall, file exists empty and reports cleaned', async () => {
    // A user may deliberately create an empty .bashrc to override a distro's
    // default startup script. When ailoud installs into it, it adds a block and
    // reports "updated". On uninstall, removing that block leaves it empty, but
    // the file must not be deleted — it was not created by ailoud and must not
    // be destroyed by uninstall. The outcome must be "cleaned", not "removed".
    const fs = new MemFs({ [`${HOME}/.bashrc`]: '' });
    const bash = findShell('bash')!;

    // First install into the empty file
    const installOutcome = await install(fs, bash, TREE, PLACES);
    expect(actions(installOutcome.files)[`${HOME}/.bashrc`]).toBe('updated');

    // Then uninstall
    const uninstallOutcome = await uninstall(fs, bash, PLACES);
    const byPath = actions(uninstallOutcome.files);
    expect(byPath[`${HOME}/.bashrc`]).toBe('cleaned');
    expect(await fs.exists(`${HOME}/.bashrc`)).toBe(true);
    expect(await fs.readTextFile(`${HOME}/.bashrc`)).toBe('');
  });
});

describe('refresh', () => {
  it('returns null when nothing is installed', async () => {
    const fs = new MemFs({});
    const bash = findShell('bash')!;
    expect(await refresh(fs, bash, TREE, PLACES)).toBeNull();
  });

  it('rewrites a stale script when the block is present', async () => {
    const fs = new MemFs({});
    const bash = findShell('bash')!;
    await install(fs, bash, TREE, PLACES);
    await fs.writeTextFile(`${DATA}/completions/ailoud.bash`, '# stale script\n');

    const outcome = await refresh(fs, bash, TREE, PLACES);
    expect(outcome).not.toBeNull();
    const script = await fs.readTextFile(`${DATA}/completions/ailoud.bash`);
    expect(script).not.toContain('stale');
    expect(script).toContain('_ailoud');
  });

  it('sweeps a shell the user no longer runs: a hand-written zsh block is still regenerated', async () => {
    // The caller may know only that $SHELL currently names bash, but an
    // earlier install may have left a block in .zshrc. refresh does not take
    // the environment at all -- given the zsh target, it acts on zsh's own
    // installed state regardless of what shell is running right now.
    const zsh = findShell('zsh')!;
    const zshBlockBody = zsh.rcBlockBody(`${DATA}/completions/_ailoud`);
    const handWritten = [START, ...zshBlockBody, '# <<< ailoud completions <<<'].join('\n');
    const fs = new MemFs({ [`${HOME}/.zshrc`]: `${handWritten}\n` });

    const outcome = await refresh(fs, zsh, TREE, PLACES);
    expect(outcome).not.toBeNull();
    expect(await fs.exists(`${DATA}/completions/_ailoud`)).toBe(true);
    expect(await fs.readTextFile(`${DATA}/completions/_ailoud`)).toContain('_ailoud');
  });

  it('never installs something new for a shell with nothing of ours in it', async () => {
    const fs = new MemFs({ [`${HOME}/.bashrc`]: 'export PATH="$PATH:/opt/tool/bin"\n' });
    const bash = findShell('bash')!;
    expect(await refresh(fs, bash, TREE, PLACES)).toBeNull();
    expect(await fs.exists(`${DATA}/completions/ailoud.bash`)).toBe(false);
  });
});

describe('the startup file is written atomically', () => {
  /** Records the order of writes and renames, so the mechanism is checkable. */
  class RecordingFs extends MemFs {
    public readonly calls: string[] = [];
    public override async writeTextFile(path: string, content: string): Promise<void> {
      this.calls.push(`write:${path}`);
      return super.writeTextFile(path, content);
    }
    public override async rename(from: string, to: string): Promise<void> {
      this.calls.push(`rename:${from}->${to}`);
      return super.rename(from, to);
    }
  }

  it('writes a temporary file and renames it over .bashrc rather than truncating it in place', async () => {
    // The MECHANISM is what this asserts, deliberately -- see mcp/install.ts's
    // `write` for the ENOSPC scenario `MemFs` cannot reproduce: a bare
    // `writeTextFile` truncates the target before a failed write empties it,
    // and the target here is the user's own `.bashrc`.
    const fs = new RecordingFs({ [`${HOME}/.bashrc`]: '# my own notes\n' });
    const bash = findShell('bash')!;

    await install(fs, bash, TREE, PLACES);

    const rc = fs.calls.filter((call) => call.includes('.bashrc'));
    expect(rc.some((call) => call.startsWith('write:') && call.includes('.tmp'))).toBe(true);
    expect(
      rc.some((call) => call.startsWith('rename:') && call.endsWith(`->${HOME}/.bashrc`)),
    ).toBe(true);
    expect(rc).not.toContain(`write:${HOME}/.bashrc`);
  });
});
