import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The release scripts, driven end to end.
 *
 * Two of them WRITE -- fold-prereleases rewrites CHANGES.md and release-notes
 * creates RELEASE_NOTES.md -- so running them against this repository would
 * damage the real changelog. Each script resolves the repository root from its
 * own location, so copying `scripts/` into a throwaway directory beside a
 * fixture CHANGES.md puts them somewhere they can do no harm. Every test
 * asserts it is working under the temp directory before it runs anything.
 */
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

let sandbox = null;

afterEach(() => {
  if (sandbox !== null) rmSync(sandbox, { recursive: true, force: true });
  sandbox = null;
});

/** A throwaway repository holding only the scripts and a CHANGES.md. */
function makeSandbox(changes) {
  sandbox = mkdtempSync(join(tmpdir(), 'ailoud-scripts-'));
  // The guard that keeps a mistake here from touching the real file.
  expect(sandbox.startsWith(tmpdir())).toBe(true);
  expect(sandbox).not.toBe(REPO);
  cpSync(join(REPO, 'scripts'), join(sandbox, 'scripts'), { recursive: true });
  writeFileSync(join(sandbox, 'CHANGES.md'), changes, 'utf8');
  return sandbox;
}

/**
 * spawnSync rather than execFileSync: the latter returns stdout only, and
 * throws away stderr on success -- which is exactly where a warning goes. A
 * soft-limit test could never have seen it.
 */
function run(dir, script, args = []) {
  const result = spawnSync(process.execPath, [join(dir, 'scripts', script), ...args], {
    encoding: 'utf8',
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

const changes = (body) => `# AILoud Changelog\n\n${body}`;
const entries = (count, prefix = 'Entry') =>
  Array.from({ length: count }, (_, i) => `- ${prefix} ${i + 1}.`).join('\n');

describe('check-changelog', () => {
  it('passes a version with entries and nothing stranded', () => {
    const dir = makeSandbox(changes(`## Development\n\n## Version 1.0.0\n\n### Added\n\n- One.\n`));
    const result = run(dir, 'check-changelog.mjs', ['v1.0.0']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/1\.0\.0 is ready \(1 entries\)/);
  });

  it('refuses a version with no section', () => {
    const dir = makeSandbox(changes('## Development\n\n- Something.\n'));
    const result = run(dir, 'check-changelog.mjs', ['v9.9.9']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/no "## Version 9\.9\.9" section/);
  });

  it('refuses a section with no entries', () => {
    const dir = makeSandbox(changes('## Development\n\n## Version 1.0.0\n\n### Added\n'));
    expect(run(dir, 'check-changelog.mjs', ['1.0.0']).stderr).toMatch(/has no entries/);
  });

  it('refuses entries left stranded under Development', () => {
    // An entry left there is a change that shipped and went unmentioned.
    const dir = makeSandbox(
      changes('## Development\n\n- Forgotten.\n\n## Version 1.0.0\n\n- One.\n'),
    );
    const result = run(dir, 'check-changelog.mjs', ['1.0.0']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/still under "## Development"/);
  });

  it('refuses a final tag whose pre-release sections were never folded', () => {
    const dir = makeSandbox(
      changes(
        '## Development\n\n## Version 1.0.0\n\n- One.\n\n## Version 1.0.0-dev.1\n\n- Older.\n',
      ),
    );
    const result = run(dir, 'check-changelog.mjs', ['1.0.0']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/pre-release section\(s\) for 1\.0\.0 are still present/);
    expect(result.stderr).toMatch(/fold-prereleases\.mjs 1\.0\.0/);
  });

  it('allows a PRE-RELEASE tag to coexist with its siblings', () => {
    // Only a final tag has to have folded them.
    const dir = makeSandbox(
      changes(
        '## Development\n\n## Version 1.0.0-dev.2\n\n- Two.\n\n## Version 1.0.0-dev.1\n\n- One.\n',
      ),
    );
    expect(run(dir, 'check-changelog.mjs', ['v1.0.0-dev.2']).code).toBe(0);
  });

  it('reports every problem at once, not one per run', () => {
    const dir = makeSandbox(changes('## Development\n\n- Stranded.\n'));
    const result = run(dir, 'check-changelog.mjs', ['1.0.0']);
    expect(result.stderr).toMatch(/no "## Version 1\.0\.0" section/);
    expect(result.stderr).toMatch(/still under "## Development"/);
  });

  it('refuses past the hard limit and only warns past the soft one', () => {
    const over = makeSandbox(changes(`## Development\n\n## Version 1.0.0\n\n${entries(51)}\n`));
    const hard = run(over, 'check-changelog.mjs', ['1.0.0']);
    expect(hard.code).toBe(1);
    expect(hard.stderr).toMatch(/hard limit is 50/);

    const soft = makeSandbox(changes(`## Development\n\n## Version 1.0.0\n\n${entries(12)}\n`));
    const result = run(soft, 'check-changelog.mjs', ['1.0.0']);
    expect(result.code).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/soft limit of 10/);
  });

  it('refuses with no tag at all', () => {
    const dir = makeSandbox(changes('## Development\n'));
    expect(run(dir, 'check-changelog.mjs').stderr).toMatch(/no tag given/);
  });
});

describe('fold-prereleases', () => {
  const withPrereleases = changes(
    [
      '## Development',
      '',
      '### Added',
      '',
      '- Newest, from Development.',
      '',
      '## Version 1.0.0-dev.2',
      '',
      '### Added',
      '',
      '- From dev.2.',
      '- A duplicate that',
      '  wraps across lines.',
      '',
      '### Fixed',
      '',
      '- Only dev.2 had this.',
      '',
      '## Version 1.0.0-dev.1',
      '',
      '### Added',
      '',
      '- From dev.1.',
      '- A duplicate that wraps across lines.',
      '',
      '## Version 0.9.0',
      '',
      '### Added',
      '',
      '- An older release.',
      '',
    ].join('\n'),
  );

  it('merges the pre-releases and Development into one released section', () => {
    const dir = makeSandbox(withPrereleases);
    const result = run(dir, 'fold-prereleases.mjs', ['1.0.0']);
    expect(result.code).toBe(0);
    const out = readFileSync(join(dir, 'CHANGES.md'), 'utf8');
    expect(out).toContain('## Version 1.0.0');
    expect(out).not.toContain('1.0.0-dev.1');
    expect(out).not.toContain('1.0.0-dev.2');
  });

  it('drops a duplicate even when one copy was rewrapped', () => {
    const dir = makeSandbox(withPrereleases);
    run(dir, 'fold-prereleases.mjs', ['1.0.0']);
    const out = readFileSync(join(dir, 'CHANGES.md'), 'utf8');
    expect(out.match(/duplicate that/g)).toHaveLength(1);
  });

  it('keeps the subsection grouping', () => {
    const dir = makeSandbox(withPrereleases);
    run(dir, 'fold-prereleases.mjs', ['1.0.0']);
    const out = readFileSync(join(dir, 'CHANGES.md'), 'utf8');
    expect(out).toContain('### Added');
    expect(out).toContain('### Fixed');
    expect(out).toContain('- Only dev.2 had this.');
  });

  it('leaves an unrelated release alone', () => {
    // 1.0.0-dev.1 folds into 1.0.0 and never into another version.
    const dir = makeSandbox(withPrereleases);
    run(dir, 'fold-prereleases.mjs', ['1.0.0']);
    const out = readFileSync(join(dir, 'CHANGES.md'), 'utf8');
    expect(out).toContain('## Version 0.9.0');
    expect(out).toContain('- An older release.');
  });

  it('leaves an empty Development heading for the next cycle', () => {
    const dir = makeSandbox(withPrereleases);
    run(dir, 'fold-prereleases.mjs', ['1.0.0']);
    const out = readFileSync(join(dir, 'CHANGES.md'), 'utf8');
    const development = out.slice(out.indexOf('## Development'), out.indexOf('## Version 1.0.0'));
    expect(development).not.toMatch(/^- /m);
  });

  it('is idempotent: folding twice changes nothing more', () => {
    const dir = makeSandbox(withPrereleases);
    run(dir, 'fold-prereleases.mjs', ['1.0.0']);
    const once = readFileSync(join(dir, 'CHANGES.md'), 'utf8');
    run(dir, 'fold-prereleases.mjs', ['1.0.0']);
    expect(readFileSync(join(dir, 'CHANGES.md'), 'utf8')).toBe(once);
  });

  it('refuses anything that is not a released version', () => {
    const dir = makeSandbox(withPrereleases);
    for (const bad of ['1.0.0-dev.1', 'latest', '1.0', '']) {
      const result = run(dir, 'fold-prereleases.mjs', bad === '' ? [] : [bad]);
      expect(result.code, bad).toBe(1);
      expect(result.stderr, bad).toMatch(/expected a released version/);
    }
  });

  it('refuses past the hard limit rather than writing an oversized section', () => {
    const dir = makeSandbox(changes(`## Development\n\n${entries(51)}\n`));
    const before = readFileSync(join(dir, 'CHANGES.md'), 'utf8');
    const result = run(dir, 'fold-prereleases.mjs', ['1.0.0']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/hard limit is 50/);
    // And left the file exactly as it was.
    expect(readFileSync(join(dir, 'CHANGES.md'), 'utf8')).toBe(before);
  });
});

describe('release-notes', () => {
  it('writes the section body to RELEASE_NOTES.md and prints it', () => {
    const dir = makeSandbox(changes('## Development\n\n## Version 1.0.0\n\n### Added\n\n- One.\n'));
    const result = run(dir, 'release-notes.mjs', ['v1.0.0']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('- One.');
    expect(readFileSync(join(dir, 'RELEASE_NOTES.md'), 'utf8')).toContain('- One.');
  });

  it('refuses an unknown version rather than writing empty notes', () => {
    const dir = makeSandbox(changes('## Development\n\n## Version 1.0.0\n\n- One.\n'));
    const result = run(dir, 'release-notes.mjs', ['v2.0.0']);
    expect(result.code).toBe(1);
    expect(existsSync(join(dir, 'RELEASE_NOTES.md'))).toBe(false);
  });

  it('refuses an empty section', () => {
    const dir = makeSandbox(changes('## Development\n\n## Version 1.0.0\n'));
    expect(run(dir, 'release-notes.mjs', ['1.0.0']).stderr).toMatch(/is empty/);
  });

  it('refuses past the hard limit', () => {
    const dir = makeSandbox(changes(`## Development\n\n## Version 1.0.0\n\n${entries(51)}\n`));
    expect(run(dir, 'release-notes.mjs', ['1.0.0']).stderr).toMatch(/hard limit is 50/);
  });
});

describe("the repository's own changelog", () => {
  it('is left untouched by every test above', () => {
    // The point of the sandbox. If this ever fails, a script resolved the
    // wrong root and has been editing the real file.
    const real = readFileSync(join(REPO, 'CHANGES.md'), 'utf8');
    expect(real).toContain('# AILoud Changelog');
    expect(real).toContain('RULES FOR THIS FILE');
  });
});
