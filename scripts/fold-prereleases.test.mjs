import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { changes, entries, makeSandbox, run, useSandboxes } from './testing/harness.mjs';

useSandboxes();

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
