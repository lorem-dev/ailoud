import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  // A real `origin`, because the script deletes tags there before deleting
  // them locally -- a sandbox without one makes every push fail and says
  // nothing about the logic being tested.
  const remote = join(dir, 'origin.git');
  spawnSync('git', ['init', '--bare', remote], { encoding: 'utf8' });
  git('remote', 'add', 'origin', remote);
  git('push', '--quiet', 'origin', 'main', '--tags');
  git('fetch', '--quiet', 'origin');
  return dir;
}

/**
 * A directory holding an `npm` that records its arguments and exits with
 * `code`, for putting first on PATH.
 *
 * A test must never run the real `npm deprecate`: on a machine that happens to
 * be logged in it would deprecate the project's actual published versions.
 */
function stubNpm(dir, code) {
  const bin = join(dir, 'stub-bin');
  mkdirSync(bin, { recursive: true });
  const script = join(bin, 'npm');
  writeFileSync(
    script,
    `#!/bin/sh\necho "npm $@" >> "${join(dir, 'npm-calls.txt')}"\nexit ${code}\n`,
  );
  chmodSync(script, 0o755);
  return bin;
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
    const { code, stdout } = run(dir, 'retire-prereleases.mjs', ['1.0.0'], { cwd: dir });
    expect(code).toBe(0);
    expect(stdout).toContain('deprecate ailoud@1.0.0-dev.1');
    expect(stdout).toContain('deprecate @ailoud/core@1.0.0-dev.2');
    expect(stdout).toContain('delete tag v1.0.0-dev.1');
    expect(stdout).toContain('drop the "dev" dist-tag');
  });

  it('keeps a tag whose commit is not reachable from main', () => {
    const dir = makeTaggedSandbox();
    const { stdout, stderr } = run(dir, 'retire-prereleases.mjs', ['1.0.0'], { cwd: dir });
    expect(stdout).not.toContain('delete tag v1.0.0-dev.2');
    expect(stderr).toMatch(/keeping v1\.0\.0-dev\.2/);
  });

  it('keeps the tags when the npm side fails', () => {
    // The bug this covers: warnings do not fail anything, so a refused
    // credential or a rejected deprecate used to leave the versions
    // installable and undeprecated while the tags -- the irreversible half --
    // were deleted anyway, on a green run.
    const dir = makeTaggedSandbox();
    const stubbedNpm = stubNpm(dir, 1);
    const before = spawnSync('git', ['tag', '--list'], { cwd: dir, encoding: 'utf8' }).stdout;
    const result = run(dir, 'retire-prereleases.mjs', ['1.0.0', '--yes'], {
      cwd: dir,
      env: { PATH: `${stubbedNpm}:${process.env.PATH ?? ''}` },
    });
    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/did not happen on npm/);
    expect(spawnSync('git', ['tag', '--list'], { cwd: dir, encoding: 'utf8' }).stdout).toBe(before);
  });

  it('deletes the tags once every npm call has succeeded', () => {
    const dir = makeTaggedSandbox();
    const stubbedNpm = stubNpm(dir, 0);
    const result = run(dir, 'retire-prereleases.mjs', ['1.0.0', '--yes'], {
      cwd: dir,
      env: { PATH: `${stubbedNpm}:${process.env.PATH ?? ''}` },
    });
    expect(result.code).toBe(0);
    // v1.0.0-dev.2 is the one whose commit is not on main, so it stays.
    expect(spawnSync('git', ['tag', '--list'], { cwd: dir, encoding: 'utf8' }).stdout.trim()).toBe(
      'v1.0.0-dev.2',
    );
  });

  it('changes nothing at all without --yes', () => {
    const dir = makeTaggedSandbox();
    const before = spawnSync('git', ['tag', '--list'], { cwd: dir, encoding: 'utf8' }).stdout;
    const result = run(dir, 'retire-prereleases.mjs', ['1.0.0'], { cwd: dir });
    expect(result.stdout).toMatch(/Re-run with --yes/);
    const after = spawnSync('git', ['tag', '--list'], { cwd: dir, encoding: 'utf8' }).stdout;
    expect(after).toBe(before);
  });
});
