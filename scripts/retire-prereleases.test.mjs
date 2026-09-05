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

/**
 * A stand-in registry serving the version lists the script asks for.
 *
 * The script reads which pre-releases exist from the registry rather than from
 * git tags -- tags get deleted, and then nothing knows what still needs
 * retiring. Tests must not depend on npmjs.org being reachable or on what it
 * currently holds, so they serve their own.
 */
/**
 * A packument fixture for the three packages, written to a file.
 *
 * A file, not a stub server on a port: a server is a live handle, and a test
 * that threw before closing it hung the whole suite with nothing failing to
 * show why.
 */
function packuments(dir, prereleases, released = '1.0.0') {
  const versions = Object.fromEntries(prereleases.map((v) => [v, {}]));
  if (released) versions[released] = {};
  // `dev` defaults to the newest snapshot, or to the release when there are
  // none -- a package with no snapshots and `dev` already on the release has
  // nothing outstanding, which is the only way to express "nothing left".
  const one = {
    versions,
    'dist-tags': { latest: released, dev: prereleases.at(-1) ?? released },
  };
  const path = join(dir, 'packuments.json');
  writeFileSync(
    path,
    JSON.stringify({ '@ailoud/core': one, '@ailoud/providers': one, ailoud: one }),
  );
  return path;
}

/** A sandbox that is a git repository, with no tags in it. */
function makeGitSandbox() {
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
  git('commit', '--allow-empty', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'main');
  return dir;
}

describe('retire-prereleases', () => {
  it('refuses anything that is not a released version', () => {
    for (const arg of [[], ['1.0.0-dev.1'], ['nonsense']]) {
      expect(run(REPO, 'retire-prereleases.mjs', arg).code).not.toBe(0);
    }
  });

  it('refuses to retire in favour of a version that is not published', () => {
    // 9.9.9 exists nowhere. Deprecating snapshots "superseded by 9.9.9" would
    // point users at something they cannot install.
    const dir = makeGitSandbox();
    const fixture = packuments(dir, ['9.9.9-dev.1'], null);
    const result = run(dir, 'retire-prereleases.mjs', ['9.9.9'], {
      cwd: dir,
      env: { AILOUD_PACKUMENTS: fixture },
    });
    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/has no 9\.9\.9 published/);
  });

  it('does nothing when there is nothing left to retire', () => {
    const dir = makeGitSandbox();
    const fixture = packuments(dir, []);
    const result = run(dir, 'retire-prereleases.mjs', ['1.0.0'], {
      cwd: dir,
      env: { AILOUD_PACKUMENTS: fixture },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/nothing left to retire/);
  });

  it('plans the deprecations and the deletions it can make safely', () => {
    const dir = makeTaggedSandbox();
    const fixture = packuments(dir, ['1.0.0-dev.1', '1.0.0-dev.2']);
    const { code, stdout } = run(dir, 'retire-prereleases.mjs', ['1.0.0'], {
      cwd: dir,
      env: { AILOUD_PACKUMENTS: fixture },
    });
    expect(code).toBe(0);
    expect(stdout).toContain('deprecate ailoud@1.0.0-dev.1');
    expect(stdout).toContain('deprecate @ailoud/core@1.0.0-dev.2');
    expect(stdout).toContain('delete tag v1.0.0-dev.1');
    expect(stdout).toContain('point the "dev" dist-tag at ailoud@1.0.0');
  });

  it('keeps a tag whose commit is not reachable from main', () => {
    const dir = makeTaggedSandbox();
    const fixture = packuments(dir, ['1.0.0-dev.1']);
    const { stdout, stderr } = run(dir, 'retire-prereleases.mjs', ['1.0.0'], {
      cwd: dir,
      env: { AILOUD_PACKUMENTS: fixture },
    });
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
    const fixture = packuments(dir, ['1.0.0-dev.1']);
    const result = run(dir, 'retire-prereleases.mjs', ['1.0.0', '--yes'], {
      cwd: dir,
      env: {
        PATH: `${stubbedNpm}:${process.env.PATH ?? ''}`,
        AILOUD_PACKUMENTS: fixture,
        // Required for --yes: without it the script refuses rather than
        // letting npm ask for a 2FA code on every write.
        NPM_TOKEN: 'npm_test_token',
      },
    });
    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/did not happen on npm/);
    expect(spawnSync('git', ['tag', '--list'], { cwd: dir, encoding: 'utf8' }).stdout).toBe(before);
  });

  it('deletes the tags once every npm call has succeeded', () => {
    const dir = makeTaggedSandbox();
    const stubbedNpm = stubNpm(dir, 0);
    const fixture = packuments(dir, ['1.0.0-dev.1']);
    const result = run(dir, 'retire-prereleases.mjs', ['1.0.0', '--yes'], {
      cwd: dir,
      env: {
        PATH: `${stubbedNpm}:${process.env.PATH ?? ''}`,
        AILOUD_PACKUMENTS: fixture,
        // Required for --yes: without it the script refuses rather than
        // letting npm ask for a 2FA code on every write.
        NPM_TOKEN: 'npm_test_token',
      },
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
    const fixture = packuments(dir, ['1.0.0-dev.1']);
    const result = run(dir, 'retire-prereleases.mjs', ['1.0.0'], {
      cwd: dir,
      env: { AILOUD_PACKUMENTS: fixture },
    });
    expect(result.stdout).toMatch(/Re-run with --yes/);
    const after = spawnSync('git', ['tag', '--list'], { cwd: dir, encoding: 'utf8' }).stdout;
    expect(after).toBe(before);
  });
});
