// This is the thin-wrapper test: it only checks that the CLI finds the right
// files and prints what the library builds. The extraction rules themselves
// are covered in scripts/lib/docsSurface.test.mjs, against the pure function
// directly, not by spawning a process per case.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { REPO, run } from './testing/harness.mjs';

const made = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A throwaway repository holding only the scripts and a fixture docs/ tree.
 *
 * docs-surface.mjs resolves docs/ and README.md relative to its own file
 * location, not the working directory, so copying scripts/ next to a fixture
 * tree is what puts it somewhere with content we control rather than the real
 * (and constantly changing) documentation.
 */
function makeDocsSandbox(files) {
  const dir = mkdtempSync(join(tmpdir(), 'ailoud-docs-surface-'));
  made.push(dir);
  cpSync(join(REPO, 'scripts'), join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const full = join(dir, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return dir;
}

describe('docs-surface', () => {
  it('reports the sorted, deduplicated surface across README.md and docs/', () => {
    const dir = makeDocsSandbox({
      'README.md': '```shell\nailoud audio ls --json\n```\n',
      'docs/usage/recordings.md': 'Run `ailoud audio ls` again for the same thing.\n',
      'docs/mcp.md': '`ailoud mcp` serves the library. See `ailoud mcp install`.\n',
    });

    const result = run(dir, 'docs-surface.mjs', [], { cwd: dir });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');

    const lines = result.stdout.trim().split('\n');
    expect(lines).toEqual([...lines].sort());
    expect(new Set(lines).size).toBe(lines.length);
    expect(lines).toEqual(
      expect.arrayContaining(['--json', 'ailoud audio ls', 'ailoud mcp', 'ailoud mcp install']),
    );
  });

  it('reads only README.md and docs/, not a sibling file like CONTRIBUTING.md', () => {
    const dir = makeDocsSandbox({
      'README.md': 'Nothing documented here.\n',
      'CONTRIBUTING.md': '`ailoud audio ls --secret`\n',
    });

    const result = run(dir, 'docs-surface.mjs', [], { cwd: dir });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });
});
