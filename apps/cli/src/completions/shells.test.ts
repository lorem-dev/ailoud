import { describe, expect, it } from 'vitest';
import { MemFs } from '@ailoud/core/testing';
import { SHELL_TARGETS, detect, findShell } from './shells.js';

const HOME = '/home/ann';
const CONFIG = '/home/ann/.config';
const DATA = '/home/ann/.local/share/ailoud';

describe('shell targets', () => {
  it('covers exactly bash, zsh and fish', () => {
    expect(SHELL_TARGETS.map((t) => t.shell)).toEqual(['bash', 'zsh', 'fish']);
  });

  it('puts the script under the user data directory, not a project library', () => {
    // A completion script is a property of the user's shell, not of one
    // repository. Under a project's .ailoud/ it would be installed once per
    // repository and lost on the next cd.
    const bash = findShell('bash')!;
    expect(bash.scriptPath(HOME, CONFIG, DATA)).toBe(`${DATA}/completions/ailoud.bash`);
  });

  it('puts fish under its own completions directory and needs no rc edit', () => {
    const fish = findShell('fish')!;
    expect(fish.scriptPath(HOME, CONFIG, DATA)).toBe(`${CONFIG}/fish/completions/ailoud.fish`);
    expect(fish.rcPath(HOME)).toBeNull();
  });

  it('names the zsh script _ailoud, which is what fpath lookup requires', () => {
    const zsh = findShell('zsh')!;
    expect(zsh.scriptPath(HOME, CONFIG, DATA)).toBe(`${DATA}/completions/_ailoud`);
    expect(zsh.rcPath(HOME)).toBe(`${HOME}/.zshrc`);
    const body = zsh.rcBlockBody(`${DATA}/completions/_ailoud`).join('\n');
    expect(body).toContain('fpath');
    expect(body).toContain('compinit');
  });

  it('sources the bash script from .bashrc', () => {
    const bash = findShell('bash')!;
    expect(bash.rcPath(HOME)).toBe(`${HOME}/.bashrc`);
    expect(bash.rcBlockBody('/x/ailoud.bash').join('\n')).toContain('/x/ailoud.bash');
  });
});

describe('detect', () => {
  const env = (shell?: string) => (shell === undefined ? {} : { SHELL: shell });

  it('counts a shell present when its startup file exists', async () => {
    const fs = new MemFs({});
    const zsh = findShell('zsh')!;
    expect(await detect(fs, zsh, HOME, CONFIG, env())).toBe(false);
    await fs.writeTextFile(`${HOME}/.zshrc`, '');
    expect(await detect(fs, zsh, HOME, CONFIG, env())).toBe(true);
  });

  it('counts a shell present when $SHELL names it, with no files at all', async () => {
    // A freshly installed shell with no rc file yet is exactly the user most
    // helped by having completions set up for them.
    const fs = new MemFs({});
    expect(await detect(fs, findShell('fish')!, HOME, CONFIG, env('/usr/bin/fish'))).toBe(true);
  });

  it('does not match a shell whose name merely appears inside another path', async () => {
    // `/usr/bin/bash` must not make fish look present, and a home directory
    // called /home/fisherman must not either.
    const fs = new MemFs({});
    expect(await detect(fs, findShell('fish')!, HOME, CONFIG, env('/usr/bin/bash'))).toBe(false);
  });

  it('accepts either bash startup file', async () => {
    const fs = new MemFs({});
    const bash = findShell('bash')!;
    await fs.writeTextFile(`${HOME}/.bash_profile`, '');
    expect(await detect(fs, bash, HOME, CONFIG, env())).toBe(true);
  });
});

describe('warnAbout', () => {
  it('says nothing when .bash_profile does not exist', async () => {
    const fs = new MemFs({});
    const bash = findShell('bash')!;
    expect(await bash.warnAbout!(fs, HOME)).toBeNull();
  });

  it('says nothing when .bash_profile already sources .bashrc', async () => {
    const fs = new MemFs({ [`${HOME}/.bash_profile`]: '[ -f ~/.bashrc ] && source ~/.bashrc\n' });
    const bash = findShell('bash')!;
    expect(await bash.warnAbout!(fs, HOME)).toBeNull();
  });

  it('warns when .bash_profile exists and never mentions .bashrc', async () => {
    const fs = new MemFs({ [`${HOME}/.bash_profile`]: 'export PATH="$PATH:/opt/tool/bin"\n' });
    const bash = findShell('bash')!;
    const warning = await bash.warnAbout!(fs, HOME);
    expect(warning).not.toBeNull();
    expect(warning).toContain('.bash_profile');
  });

  it('is not implemented for zsh or fish', () => {
    expect(findShell('zsh')!.warnAbout).toBeUndefined();
    expect(findShell('fish')!.warnAbout).toBeUndefined();
  });
});
