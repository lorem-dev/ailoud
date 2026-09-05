import { describe, expect, it } from 'vitest';
import { changes, entries, makeSandbox, run, useSandboxes } from './testing/harness.mjs';

useSandboxes();

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

  it('falls back to $GITHUB_REF_NAME, which is how the workflow calls it', () => {
    const dir = makeSandbox(changes('## Development\n\n## Version 1.0.0\n\n- One.\n'));
    const result = run(dir, 'check-changelog.mjs', [], { env: { GITHUB_REF_NAME: 'v1.0.0' } });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/1\.0\.0 is ready/);
  });

  it('warns as a GitHub annotation when it runs on a runner', () => {
    // ::warning:: goes to stdout and shows up on the run summary; the plain
    // warning goes to stderr. Both paths are exercised because CI once saw
    // one of them and no test ever had.
    const body = `## Development\n\n## Version 1.0.0\n\n${entries(12)}\n`;
    const annotated = run(makeSandbox(body), 'check-changelog.mjs', ['1.0.0'], {
      env: { GITHUB_ACTIONS: 'true' },
    });
    expect(annotated.stdout).toMatch(/::warning::.*soft limit of 10/);
    expect(annotated.stderr).toBe('');

    const plain = run(makeSandbox(body), 'check-changelog.mjs', ['1.0.0']);
    expect(plain.stderr).toMatch(/soft limit of 10/);
    expect(plain.stdout).not.toContain('::warning::');
  });
});
