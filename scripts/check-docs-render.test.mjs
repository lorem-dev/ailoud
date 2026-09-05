// This is the thin-wrapper test: it only checks that the CLI finds site/,
// reports counts, and exits non-zero with the offending file named. The
// detection rules themselves are covered in scripts/lib/checkDocsRender.test.mjs,
// against the pure functions directly, not by spawning a process per case.
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
 * A throwaway repository holding only the scripts and a fixture site/ tree.
 *
 * check-docs-render.mjs resolves site/ relative to its own file location, not
 * the working directory, so copying scripts/ next to a fixture tree puts it
 * somewhere with content we control rather than the real (and constantly
 * rebuilt) site/.
 */
function makeSiteSandbox(files) {
  const dir = mkdtempSync(join(tmpdir(), 'ailoud-check-docs-render-'));
  made.push(dir);
  cpSync(join(REPO, 'scripts'), join(dir, 'scripts'), { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const full = join(dir, 'site', relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return dir;
}

const ARTICLE = (inner) => `<article class="md-content__inner md-typeset">${inner}</article>`;

describe('check-docs-render', () => {
  it('exits clean and reports counts for a healthy site', () => {
    const dir = makeSiteSandbox({
      'index.html': ARTICLE('<h1 id="home">Home<a href="#home">&para;</a></h1>'),
      'mcp/index.html': ARTICLE(
        '<div class="admonition note"><p class="admonition-title">Note</p><p>Fine.</p></div>',
      ),
    });

    const result = run(dir, 'check-docs-render.mjs', [], { cwd: dir });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/checked 2 page\(s\)/);
    expect(result.stdout).toMatch(/clean/);
  });

  it('exits non-zero and names the file holding a broken admonition', () => {
    const dir = makeSiteSandbox({
      'mcp/index.html': ARTICLE(
        '<div class="admonition note"><p class="admonition-title">Note</p></div><p>Fell out.</p>',
      ),
    });

    const result = run(dir, 'check-docs-render.mjs', [], { cwd: dir });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/\[admonition\]/);
    expect(result.stderr).toMatch(/mcp[/\\]index\.html/);
  });

  it('refuses to run with no site/ built yet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ailoud-check-docs-render-empty-'));
    made.push(dir);
    cpSync(join(REPO, 'scripts'), join(dir, 'scripts'), { recursive: true });

    const result = run(dir, 'check-docs-render.mjs', [], { cwd: dir });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/pnpm docs:build/);
  });
});
