import { describe, expect, it } from 'vitest';
import { detectInstallMethod, installCommandFor, sweepCommandFor } from './installMethod.js';
import type { DetectOptions } from './installMethod.js';

function fakeRoots(roots: { npm?: string; pnpm?: string }): DetectOptions['run'] {
  return async (command, _args) => {
    const root = command === 'npm' ? roots.npm : command === 'pnpm' ? roots.pnpm : undefined;
    if (root === undefined) return { code: 1, stdout: '', stderr: `${command}: command not found` };
    return { code: 0, stdout: root, stderr: '' };
  };
}

describe('detectInstallMethod', () => {
  it('detects a global pnpm install through a symlinked root', async () => {
    // pnpm's global bin is a symlink farm, so an unresolved string compare
    // misses every time. This test fails on any implementation that skips
    // realpath.
    const method = await detectInstallMethod({
      packageRoot: '/Users/x/.local/share/pnpm/global/5/node_modules/ailoud',
      execPath: '/usr/local/bin/node',
      realpath: async (p) => p.replace('/link/', '/real/'),
      run: fakeRoots({
        npm: '/opt/homebrew/lib/node_modules',
        pnpm: '/Users/x/.local/share/pnpm/global/5/node_modules',
      }),
    });
    expect(method.kind).toBe('pnpm-global');
  });

  it('refuses an npx cache entry', async () => {
    // An npx cache entry also sits inside a node_modules directory, so this
    // packageRoot would be mistaken for a project dependency if the
    // /_npx/ check were not evaluated first.
    const method = await detectInstallMethod({
      packageRoot: '/Users/x/.npm/_npx/abcd1234/node_modules/ailoud',
      execPath: '/usr/local/bin/node',
      realpath: async (p) => p,
      run: fakeRoots({
        npm: '/opt/homebrew/lib/node_modules',
        pnpm: '/Users/x/.local/share/pnpm/global/5/node_modules',
      }),
    });
    expect(method).toEqual({ kind: 'npx', hint: 'npx ailoud@<version>' });
  });

  it('refuses a project dependency and names the project', async () => {
    const method = await detectInstallMethod({
      packageRoot: '/Users/x/code/some-app/node_modules/ailoud',
      execPath: '/usr/local/bin/node',
      realpath: async (p) => p,
      run: fakeRoots({
        npm: '/opt/homebrew/lib/node_modules',
        pnpm: '/Users/x/.local/share/pnpm/global/5/node_modules',
      }),
    });
    expect(method).toEqual({
      kind: 'project',
      projectDir: '/Users/x/code/some-app',
      hint: "run your package manager's add command in /Users/x/code/some-app",
    });
  });

  it('is unknown when neither manager claims the root', async () => {
    const method = await detectInstallMethod({
      packageRoot: '/opt/custom/ailoud',
      execPath: '/usr/local/bin/node',
      realpath: async (p) => p,
      run: fakeRoots({
        npm: '/opt/homebrew/lib/node_modules',
        pnpm: '/Users/x/.local/share/pnpm/global/5/node_modules',
      }),
    });
    expect(method).toEqual({
      kind: 'unknown',
      hint: 'npm install -g ailoud@<version>, or pnpm add -g ailoud@<version>',
    });
  });

  it('survives a package manager that is not installed', async () => {
    // pnpm is not on this machine: its "root -g" rejects instead of
    // answering. Detection must still resolve via npm rather than throwing.
    const method = await detectInstallMethod({
      packageRoot: '/opt/homebrew/lib/node_modules/ailoud',
      execPath: '/usr/local/bin/node',
      realpath: async (p) => p,
      run: async (command) => {
        if (command === 'pnpm') throw new Error('spawn pnpm ENOENT');
        return { code: 0, stdout: '/opt/homebrew/lib/node_modules', stderr: '' };
      },
    });
    expect(method.kind).toBe('npm-global');
  });
});

describe('installCommandFor', () => {
  it('anchors the npm-global install beside the running node, not to a bare "npm"', () => {
    // A bare 'npm' resolves off PATH, which can belong to an entirely
    // different Node than the one running us (nvm/fnm/asdf/volta) -- see
    // this module's own doc comment on DetectOptions.execPath for the
    // machine layout that breaks under a bare name.
    const command = installCommandFor(
      { kind: 'npm-global' },
      '1.0.1',
      '/home/x/.nvm/versions/node/v20.11.0/bin/node',
    );
    expect(command).toEqual([
      '/home/x/.nvm/versions/node/v20.11.0/bin/npm',
      'install',
      '-g',
      'ailoud@1.0.1',
    ]);
  });

  it('keeps the pnpm-global install as a bare "pnpm", deliberately', () => {
    // pnpm's global bin comes from PNPM_HOME/corepack, not from any one
    // Node's install tree, so there is no execPath-equivalent anchor for it
    // -- bare 'pnpm' IS the correct resolution. Asserted explicitly so
    // nobody "fixes" this into a broken anchor later.
    const command = installCommandFor(
      { kind: 'pnpm-global' },
      '1.0.1',
      '/home/x/.nvm/versions/node/v20.11.0/bin/node',
    );
    expect(command).toEqual(['pnpm', 'add', '-g', 'ailoud@1.0.1']);
  });

  it('refuses to build a command for a method that cannot be updated', () => {
    expect(
      installCommandFor({ kind: 'npx', hint: 'npx ailoud@1.0.1' }, '1.0.1', '/usr/local/bin/node'),
    ).toBeNull();
  });

  it('names the project, not the pnpm store entry, for a pnpm-installed dependency', async () => {
    // pnpm puts a project dependency at
    // <project>/node_modules/.pnpm/<name>@<version>/node_modules/<name>.
    // Taking the LAST `/node_modules/` named the store entry, so the hint told
    // the user to run their add command in `.../.pnpm/ailoud@1.0.0`.
    const method = await detectInstallMethod({
      packageRoot: '/Users/x/repo/node_modules/.pnpm/ailoud@1.0.0/node_modules/ailoud',
      execPath: '/usr/local/bin/node',
      realpath: async (path: string) => path,
      run: async () => ({ code: 0, stdout: '/nowhere\n', stderr: '' }),
    });
    expect(method).toEqual({
      kind: 'project',
      projectDir: '/Users/x/repo',
      hint: "run your package manager's add command in /Users/x/repo",
    });
  });

  it('detects a global install under a version manager, where PATH npm is a different Node', async () => {
    // nvm, fnm, asdf and volta all do this: the npm on PATH belongs to another
    // Node version, so `npm root -g` reports THAT version's root, ours never
    // matches, and an ordinary global install used to read as a project
    // dependency -- telling the user to run an add command inside
    // `~/.nvm/versions/node/v18.20.4/lib`.
    const method = await detectInstallMethod({
      execPath: '/home/x/.nvm/versions/node/v18.20.4/bin/node',
      packageRoot: '/home/x/.nvm/versions/node/v18.20.4/lib/node_modules/ailoud',
      realpath: async (path: string) => path,
      run: async () => ({
        code: 0,
        stdout: '/home/x/.nvm/versions/node/v20.11.0/lib/node_modules\n',
        stderr: '',
      }),
    });
    expect(method).toEqual({ kind: 'npm-global' });
  });

  it('does not mistake a sibling directory for the global root', async () => {
    // `startsWith` compares characters, not path components, so
    // `/usr/lib/node_modules-other` used to read as living under
    // `/usr/lib/node_modules`.
    const method = await detectInstallMethod({
      execPath: '/usr/bin/node',
      packageRoot: '/usr/lib/node_modules-other/ailoud',
      realpath: async (path: string) => path,
      run: async () => ({ code: 0, stdout: '/usr/lib/node_modules\n', stderr: '' }),
    });
    expect(method.kind).not.toBe('npm-global');
  });
});

describe('sweepCommandFor', () => {
  it('anchors the npm-global sweep beside the running node, not to a bare "ailoud"', async () => {
    // Same reasoning as the install: a bare 'ailoud' resolves off PATH, which
    // can be a completely different install than the one the package manager
    // just wrote -- the exact staleness bug the subprocess sweep exists to
    // prevent.
    const command = await sweepCommandFor(
      { kind: 'npm-global' },
      '/home/x/.nvm/versions/node/v20.11.0/bin/node',
      async () => ({ code: 1, stdout: '', stderr: 'unused for npm-global' }),
    );
    expect(command).toEqual(['/home/x/.nvm/versions/node/v20.11.0/bin/ailoud', 'self', 'sync']);
  });

  it('anchors the pnpm-global sweep to the path "pnpm bin -g" reports', async () => {
    const seen: Array<{ command: string; args: readonly string[] }> = [];
    const command = await sweepCommandFor(
      { kind: 'pnpm-global' },
      '/usr/local/bin/node',
      async (cmd, args) => {
        seen.push({ command: cmd, args });
        return { code: 0, stdout: '/home/x/.local/share/pnpm\n', stderr: '' };
      },
    );
    expect(seen).toEqual([{ command: 'pnpm', args: ['bin', '-g'] }]);
    expect(command).toEqual(['/home/x/.local/share/pnpm/ailoud', 'self', 'sync']);
  });

  it('answers null, rather than a guess, when "pnpm bin -g" fails', async () => {
    const command = await sweepCommandFor(
      { kind: 'pnpm-global' },
      '/usr/local/bin/node',
      async () => ({ code: 1, stdout: '', stderr: 'pnpm: command not found' }),
    );
    expect(command).toBeNull();
  });

  it('answers null when "pnpm bin -g" throws rather than exiting non-zero', async () => {
    const command = await sweepCommandFor(
      { kind: 'pnpm-global' },
      '/usr/local/bin/node',
      async () => {
        throw new Error('spawn pnpm ENOENT');
      },
    );
    expect(command).toBeNull();
  });

  it('answers null for a method that cannot be updated', async () => {
    const command = await sweepCommandFor(
      { kind: 'unknown', hint: 'npm install -g ailoud@<version>, or pnpm add -g ailoud@<version>' },
      '/usr/local/bin/node',
      async () => ({ code: 0, stdout: '/nowhere', stderr: '' }),
    );
    expect(command).toBeNull();
  });
});
