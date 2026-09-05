import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { changes, entries, makeSandbox, run, useSandboxes } from './testing/harness.mjs';

useSandboxes();

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
