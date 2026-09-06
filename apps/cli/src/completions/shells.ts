import { basename, dirname, join } from 'node:path';
import type { Fs } from '@ailoud/core';
import { SHELLS, type Shell } from './generate.js';

export interface ShellTarget {
  readonly shell: Shell;
  readonly label: string;
  /** Where the generated script goes. */
  scriptPath(home: string, configHome: string, userDataDir: string): string;
  /**
   * The startup file to wire the script into, or null when the shell needs
   * none. fish autoloads its completions directory, so it needs none.
   */
  rcPath(home: string): string | null;
  /** The line(s) that go inside the marker block, sourcing the script. */
  rcBlockBody(scriptPath: string): readonly string[];
  /** Paths whose existence suggests this shell is in use. */
  detectPaths(home: string, configHome: string): readonly string[];
  /**
   * Whether this shell's startup file will actually be read.
   *
   * An interactive LOGIN bash on macOS reads `~/.bash_profile` and never
   * `~/.bashrc`, so a block written to `.bashrc` alone is a file the shell
   * never opens -- an install that reports success and does nothing. Rather
   * than edit a second startup file (two files edited for one shell is harder
   * to undo than it is to explain), the caller is told, and decides.
   *
   * Null when there is nothing to say. Non-null is a sentence for the user.
   */
  warnAbout?(fs: Fs, home: string): Promise<string | null>;
}

/**
 * Whether `content` already wires `.bashrc` into a login shell's startup, in
 * any of the ways people actually write that line.
 */
function mentionsBashrc(content: string): boolean {
  return content.includes('.bashrc');
}

async function bashWarnAbout(fs: Fs, home: string): Promise<string | null> {
  const profile = join(home, '.bash_profile');
  if (!(await fs.exists(profile))) return null;
  const content = await fs.readTextFile(profile);
  if (mentionsBashrc(content)) return null;
  return (
    '~/.bash_profile exists and does not source ~/.bashrc, so an interactive login ' +
    'bash (the default on macOS Terminal) will not read the completions block just ' +
    'written to ~/.bashrc. Add "[ -f ~/.bashrc ] && source ~/.bashrc" to ~/.bash_profile, ' +
    'or open a non-login shell to pick up the change.'
  );
}

/**
 * The shells ailoud can wire completions into.
 *
 * Every path and startup-file name here was read from a working install of
 * that shell rather than from memory: guessing one writes a script nothing
 * sources, which looks exactly like a successful install and is only
 * discovered when Tab does nothing.
 */
export const SHELL_TARGETS: readonly ShellTarget[] = [
  {
    shell: 'bash',
    label: 'Bash',
    scriptPath: (_home, _configHome, userDataDir) =>
      join(userDataDir, 'completions', 'ailoud.bash'),
    rcPath: (home) => join(home, '.bashrc'),
    rcBlockBody: (scriptPath) => [`[ -f "${scriptPath}" ] && source "${scriptPath}"`],
    // Either startup file counts as "bash is in use": a fresh install may
    // carry only .bash_profile, and an existing one only .bashrc.
    detectPaths: (home) => [join(home, '.bashrc'), join(home, '.bash_profile')],
    warnAbout: bashWarnAbout,
  },
  {
    shell: 'zsh',
    label: 'Zsh',
    scriptPath: (_home, _configHome, userDataDir) => join(userDataDir, 'completions', '_ailoud'),
    rcPath: (home) => join(home, '.zshrc'),
    // zsh completions are functions named `_ailoud`, found via `fpath` rather
    // than sourced directly; compinit is what makes zsh look them up at all.
    rcBlockBody: (scriptPath) => [
      `fpath=("${dirname(scriptPath)}" $fpath)`,
      'autoload -Uz compinit && compinit -u',
    ],
    detectPaths: (home) => [join(home, '.zshrc')],
  },
  {
    shell: 'fish',
    label: 'Fish',
    // fish autoloads every file under its own completions directory, keyed
    // by the XDG config home rather than the user data directory the other
    // two shells use.
    scriptPath: (_home, configHome, _userDataDir) =>
      join(configHome, 'fish', 'completions', 'ailoud.fish'),
    rcPath: () => null,
    rcBlockBody: () => [],
    detectPaths: (_home, configHome) => [join(configHome, 'fish', 'config.fish')],
  },
];

// Keeps this table from drifting out of sync with the renderer: generate.ts
// would silently produce no script for a shell missing here, and TypeScript
// cannot catch that because SHELL_TARGETS is a plain array, not a record
// keyed by Shell.
if (
  SHELL_TARGETS.length !== SHELLS.length ||
  SHELL_TARGETS.some((target, index) => target.shell !== SHELLS[index])
) {
  throw new Error('SHELL_TARGETS is out of sync with SHELLS in ./generate.js');
}

export function findShell(id: string): ShellTarget | undefined {
  const wanted = id.trim().toLowerCase();
  return SHELL_TARGETS.find((target) => target.shell === wanted);
}

export function shellIds(): string {
  return SHELL_TARGETS.map((target) => target.shell).join(', ');
}

/**
 * Whether `target`'s shell looks like one the user actually has.
 *
 * Two independent signals, either sufficient: a startup file already on
 * disk, or `$SHELL` naming this shell for a user who has not created one yet.
 * `$SHELL` is compared by basename, not by substring -- `/usr/bin/bash`
 * contains none of the letters "fish", but a home directory such as
 * `/home/fisherman` or a shell path containing another shell's name as a
 * substring is exactly the false positive a substring match invites, and
 * basename comparison against the full shell name sidesteps it.
 */
export async function detect(
  fs: Fs,
  target: ShellTarget,
  home: string,
  configHome: string,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  for (const path of target.detectPaths(home, configHome)) {
    if (await fs.exists(path)) return true;
  }
  const shellEnv = env['SHELL'];
  return shellEnv !== undefined && basename(shellEnv) === target.shell;
}
