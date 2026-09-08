import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { makeSandbox } from '../src/cli';
import type { Sandbox } from '../src/cli';

/**
 * End-to-end coverage of `ailoud self completions install|uninstall|update|print`.
 *
 * Driven through the built binary in a sandboxed HOME, XDG_CONFIG_HOME and
 * XDG_DATA_HOME. This is the one part of the feature whose whole job is
 * editing a real shell startup file: a unit test can prove the generator and
 * the marker-block writer are each right in isolation, but only running the
 * binary against a real `.bashrc` proves it finds the right file, leaves a
 * hand-written line in it alone, and never touches a file it was not told to.
 */

// Mirrors the pair exported as START/END from apps/cli/src/completions/install.ts.
// Not imported: no e2e spec imports product source (see cli.ts's own doc
// comment) -- the built binary's actual output is what is under test here.
const START = '# >>> ailoud completions >>>';
const END = '# <<< ailoud completions <<<';

jest.setTimeout(120_000);

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const read = (path: string): Promise<string> => readFile(path, 'utf8');

/**
 * Where each shell's files land, mirroring apps/cli/src/completions/shells.ts:
 * bash and zsh write into the user data directory, fish into
 * XDG_CONFIG_HOME/fish/completions (fish autoloads that directory itself, so
 * it alone gets no rc file).
 */
function completionPaths(sandbox: Sandbox) {
  // sandbox.configFile is "<configHome>/ailoud/config.yaml" (see config.ts).
  const configHome = dirname(dirname(sandbox.configFile));
  return {
    bashScript: join(sandbox.dataDir, 'completions', 'ailoud.bash'),
    zshScript: join(sandbox.dataDir, 'completions', '_ailoud'),
    fishScript: join(configHome, 'fish', 'completions', 'ailoud.fish'),
    bashrc: join(sandbox.home, '.bashrc'),
    zshrc: join(sandbox.home, '.zshrc'),
  };
}

describe('ailoud self completions', () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it('print bash writes a script to stdout and installs nothing', async () => {
    const result = await sandbox.run(['self', 'completions', 'print', 'bash']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('-F _ailoud ailoud');

    // "print" only renders; it must never reach for the install/rc writers.
    const p = completionPaths(sandbox);
    for (const path of [p.bashScript, p.zshScript, p.fishScript, p.bashrc, p.zshrc]) {
      expect(await exists(path)).toBe(false);
    }
  });

  it('names a real command in the generated bash script', async () => {
    // Catches a generator that emits an empty (or wrongly-scoped) case table:
    // every structural unit test can pass while the script itself completes
    // to nothing, because none of them render the live command tree end to
    // end the way the binary does here.
    const result = await sandbox.run(['self', 'completions', 'print', 'bash']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/\b(transcribe|summarize)\b/);
  });

  it('install --shell bash writes the script and the block, keeping a hand-written line', async () => {
    const p = completionPaths(sandbox);
    await writeFile(p.bashrc, 'export EDITOR=vim\n', 'utf8');

    const result = await sandbox.run(['self', 'completions', 'install', '--shell', 'bash']);
    expect(result.code).toBe(0);

    expect(await read(p.bashScript)).toContain('-F _ailoud ailoud');

    const rc = await read(p.bashrc);
    expect(rc).toContain('export EDITOR=vim');
    expect(rc).toContain(START);
    expect(rc).toContain(END);
    expect(rc).toContain(p.bashScript);
  });

  it('reports no change on a second install', async () => {
    await sandbox.run(['self', 'completions', 'install', '--shell', 'bash']);
    const before = await read(completionPaths(sandbox).bashrc);

    const second = await sandbox.run(['self', 'completions', 'install', '--shell', 'bash']);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('unchanged');
    expect(second.stdout).not.toMatch(/created|updated/);
    expect(await read(completionPaths(sandbox).bashrc)).toBe(before);
  });

  it('uninstall --shell bash removes both, keeping the hand-written line', async () => {
    const p = completionPaths(sandbox);
    await writeFile(p.bashrc, 'export EDITOR=vim\n', 'utf8');
    await sandbox.run(['self', 'completions', 'install', '--shell', 'bash']);

    const result = await sandbox.run(['self', 'completions', 'uninstall', '--shell', 'bash']);
    expect(result.code).toBe(0);

    expect(await exists(p.bashScript)).toBe(false);
    const rc = await read(p.bashrc);
    expect(rc).toContain('export EDITOR=vim');
    expect(rc).not.toContain(START);
    expect(rc).not.toContain(END);
  });

  it('install --shell fish writes only the fish file and edits no startup file', async () => {
    const p = completionPaths(sandbox);
    const result = await sandbox.run(['self', 'completions', 'install', '--shell', 'fish']);
    expect(result.code).toBe(0);

    expect(await exists(p.fishScript)).toBe(true);
    for (const path of [p.bashScript, p.zshScript, p.bashrc, p.zshrc]) {
      expect(await exists(path)).toBe(false);
    }
  });
});
