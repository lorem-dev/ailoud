import { describe, expect, it } from 'vitest';
import { detectInstallMethod, installCommandFor } from './installMethod.js';
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
  it('builds the right command per manager', () => {
    expect(installCommandFor({ kind: 'npm-global' }, '1.0.1')).toEqual([
      'npm',
      'install',
      '-g',
      'ailoud@1.0.1',
    ]);
    expect(installCommandFor({ kind: 'pnpm-global' }, '1.0.1')).toEqual([
      'pnpm',
      'add',
      '-g',
      'ailoud@1.0.1',
    ]);
    expect(installCommandFor({ kind: 'npx', hint: 'npx ailoud@1.0.1' }, '1.0.1')).toBeNull();
  });
});
