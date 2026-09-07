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

  it('never writes compinit -u, which would trust every insecure fpath directory', () => {
    // `-u` tells compinit to load completion functions from every
    // group-writable directory in fpath instead of refusing them. A Homebrew
    // user with a group-writable /opt/homebrew/share/zsh/site-functions would
    // start sourcing every `_*` file there at each shell start, because ailoud
    // edited their .zshrc. `-i` skips those directories and still never
    // prompts, which is all the block needed.
    const body = findShell('zsh')!.rcBlockBody(`${DATA}/completions/_ailoud`).join('\n');
    expect(body).toContain('compinit -i');
    expect(body).not.toContain('compinit -u');
  });

  it('re-runs compinit only when nothing else already did', () => {
    // oh-my-zsh and prezto run compinit before the end of .zshrc, where this
    // block lands. Re-running it there rebuilds a table of ~1700 entries to
    // add one; `compdef` registers the single function instead. The branch is
    // needed at all because adding to fpath after compinit has run registers
    // nothing -- compinit reads fpath once.
    const body = findShell('zsh')!.rcBlockBody(`${DATA}/completions/_ailoud`).join('\n');
    expect(body).toContain('${+_comps}');
    expect(body).toContain('compdef _ailoud ailoud');
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
    // A naive substring match (env.includes(target.shell)) would see "fish"
    // inside "fisherman" and wrongly count fish as present for a bash user
    // whose home or shell path happens to contain those letters. Comparing
    // /usr/bin/bash against fish proves nothing here -- "bash" contains no
    // "fish" under either strategy -- so the path below must actually embed
    // "fish" as a substring without the basename being fish.
    const fs = new MemFs({});
    expect(
      await detect(fs, findShell('fish')!, HOME, CONFIG, env('/home/fisherman/bin/bash')),
    ).toBe(false);
  });

  it('accepts either bash startup file', async () => {
    const fs = new MemFs({});
    const bash = findShell('bash')!;
    await fs.writeTextFile(`${HOME}/.bash_profile`, '');
    expect(await detect(fs, bash, HOME, CONFIG, env())).toBe(true);
  });

  it('counts a shell present when its binary is on $PATH, with no rc file and another $SHELL', async () => {
    // The third signal the design lists, and the one the other two miss: a
    // user who installed fish but has never launched it has no
    // ~/.config/fish/ and still has $SHELL=/bin/zsh. That is precisely the
    // user the signal exists for.
    const fs = new MemFs({});
    const fish = findShell('fish')!;
    const at = { SHELL: '/bin/zsh', PATH: '/usr/bin:/opt/homebrew/bin' };
    expect(await detect(fs, fish, HOME, CONFIG, at)).toBe(false);
    await fs.writeTextFile('/opt/homebrew/bin/fish', '');
    expect(await detect(fs, fish, HOME, CONFIG, at)).toBe(true);
  });

  it('does not read an empty $PATH entry as the current directory', async () => {
    // POSIX reads an empty element as ".", so resolving one would ask about
    // ./fish and call the shell present because the user happened to be
    // standing in a directory holding a file of that name.
    const fs = new MemFs({});
    await fs.writeTextFile('fish', '');
    expect(await detect(fs, findShell('fish')!, HOME, CONFIG, { PATH: ':/usr/bin' })).toBe(false);
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

  it('warns when the only mention of .bashrc is commented out', async () => {
    // A disabled line reads as "not wired in" -- if it counted as handled,
    // the user would get no warning and completions would silently never
    // load, discoverable only by a confused "why doesn't Tab work" report.
    const fs = new MemFs({
      [`${HOME}/.bash_profile`]: '# used to source .bashrc, stopped\nexport PATH="$PATH:/x"\n',
    });
    const bash = findShell('bash')!;
    expect(await bash.warnAbout!(fs, HOME)).not.toBeNull();
  });

  it('is not implemented for zsh or fish', () => {
    expect(findShell('zsh')!.warnAbout).toBeUndefined();
    expect(findShell('fish')!.warnAbout).toBeUndefined();
  });
});
