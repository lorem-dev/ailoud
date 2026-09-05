/**
 * Shared harness for the release-script tests, one test module per script.
 *
 * Two of the scripts WRITE -- fold-prereleases rewrites CHANGES.md and
 * release-notes creates RELEASE_NOTES.md -- so running them against this
 * repository would damage the real changelog. Each script resolves the
 * repository root from its own location, so copying `scripts/` into a
 * throwaway directory beside a fixture CHANGES.md puts them somewhere they can
 * do no harm. Every sandbox asserts it is under the temp directory before a
 * script runs, and `useSandboxes` re-checks the real changelog after every
 * single test rather than once at the end of one big file.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect } from 'vitest';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const made = new Set();

/**
 * Register cleanup and the untouched-repository guard for a test module.
 *
 * Call once at the top of each test file. Tracking every sandbox in a set
 * rather than one variable means a test that makes two of them still has both
 * removed.
 */
export function useSandboxes() {
  afterEach(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
    made.clear();
    expectRepoUntouched();
  });
}

/** A throwaway repository holding only the scripts and a CHANGES.md. */
export function makeSandbox(changes) {
  const sandbox = mkdtempSync(join(tmpdir(), 'ailoud-scripts-'));
  // The guard that keeps a mistake here from touching the real file.
  expect(sandbox.startsWith(tmpdir())).toBe(true);
  expect(sandbox).not.toBe(REPO);
  made.add(sandbox);
  cpSync(join(REPO, 'scripts'), join(sandbox, 'scripts'), { recursive: true });
  writeFileSync(join(sandbox, 'CHANGES.md'), changes, 'utf8');
  return sandbox;
}

/**
 * spawnSync rather than execFileSync: the latter returns stdout only, and
 * throws away stderr on success -- which is exactly where a warning goes. A
 * soft-limit test could never have seen it.
 */
export function run(dir, script, args = [], cwd = REPO) {
  const result = spawnSync(process.execPath, [join(dir, 'scripts', script), ...args], {
    encoding: 'utf8',
    cwd,
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * The bytes of the real changelog, read once when this module loads -- before
 * any test has run a script.
 */
const REAL_CHANGES = readFileSync(join(REPO, 'CHANGES.md'), 'utf8');

/**
 * The point of the sandbox. If either of these fails, a script resolved the
 * wrong root and has been writing to the repository: `fold-prereleases`
 * rewrites the changelog in place, and `release-notes` creates
 * RELEASE_NOTES.md beside it.
 */
export function expectRepoUntouched() {
  expect(readFileSync(join(REPO, 'CHANGES.md'), 'utf8')).toBe(REAL_CHANGES);
  expect(existsSync(join(REPO, 'RELEASE_NOTES.md'))).toBe(false);
}

export const changes = (body) => `# AILoud Changelog\n\n${body}`;

export const entries = (count, prefix = 'Entry') =>
  Array.from({ length: count }, (_, i) => `- ${prefix} ${i + 1}.`).join('\n');
