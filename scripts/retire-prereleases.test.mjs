import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { REPO, changes, makeSandbox, run, useSandboxes } from './testing/harness.mjs';

useSandboxes();

/**
 * A throwaway repository with two pre-release tags: one reachable from
 * origin/main, one only from a side branch. That is the distinction the
 * script has to draw, and it cannot be drawn without a real repository.
 */
function makeTaggedSandbox() {
  const dir = makeSandbox(changes('## Development\n'));
  const git = (...args) =>
    spawnSync(
      'git',
      [
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=Test',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: dir, encoding: 'utf8' },
    );
  git('init', '-b', 'main');
  git('commit', '--allow-empty', '-m', 'released');
  git('tag', 'v1.0.0-dev.1');
  git('checkout', '-b', 'side');
  git('commit', '--allow-empty', '-m', 'abandoned');
  git('tag', 'v1.0.0-dev.2');
  git('checkout', 'main');
  git('update-ref', 'refs/remotes/origin/main', 'main');
  return dir;
}

describe('retire-prereleases', () => {
  it('refuses anything that is not a released version', () => {
    for (const arg of [[], ['1.0.0-dev.1'], ['nonsense']]) {
      expect(run(REPO, 'retire-prereleases.mjs', arg).code).not.toBe(0);
    }
  });

  it('does nothing for a version that never had a pre-release', () => {
    const result = run(REPO, 'retire-prereleases.mjs', ['9.9.9']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/nothing to retire/);
  });

  it('plans the deprecations and the deletions it can make safely', () => {
    const dir = makeTaggedSandbox();
    const { code, stdout } = run(dir, 'retire-prereleases.mjs', ['1.0.0'], dir);
    expect(code).toBe(0);
    expect(stdout).toContain('deprecate ailoud@1.0.0-dev.1');
    expect(stdout).toContain('deprecate @ailoud/core@1.0.0-dev.2');
    expect(stdout).toContain('delete tag v1.0.0-dev.1');
    expect(stdout).toContain('drop the "dev" dist-tag');
  });

  it('keeps a tag whose commit is not reachable from main', () => {
    const dir = makeTaggedSandbox();
    const { stdout, stderr } = run(dir, 'retire-prereleases.mjs', ['1.0.0'], dir);
    expect(stdout).not.toContain('delete tag v1.0.0-dev.2');
    expect(stderr).toMatch(/keeping v1\.0\.0-dev\.2/);
  });

  it('changes nothing at all without --yes', () => {
    const dir = makeTaggedSandbox();
    const before = spawnSync('git', ['tag', '--list'], { cwd: dir, encoding: 'utf8' }).stdout;
    const result = run(dir, 'retire-prereleases.mjs', ['1.0.0'], dir);
    expect(result.stdout).toMatch(/Re-run with --yes/);
    const after = spawnSync('git', ['tag', '--list'], { cwd: dir, encoding: 'utf8' }).stdout;
    expect(after).toBe(before);
  });
});
