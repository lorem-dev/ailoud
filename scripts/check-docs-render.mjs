#!/usr/bin/env node
// Fail the build on a documentation page that RENDERED wrong, not one that
// failed to build.
//
// Usage:
//   pnpm docs:build && node scripts/check-docs-render.mjs
//
// `mkdocs build --strict` checks the nav, internal links and cross-references,
// and stays green as long as every piece of markdown is valid -- it has no
// idea what the page looks like once Material has rendered it. A `!!! note`
// block whose content is not indented four spaces is valid markdown that
// means something other than its author intended: Material renders an empty
// box, and the note's own text falls out below it as an ordinary paragraph.
// That shipped in this repository once. This script reads the built HTML
// under site/ and looks for the textual symptom each of these leaves behind:
//
//   - an admonition div holding nothing but its title
//   - a table's header row surviving as literal text, its separator missing
//   - a stray triple backtick, left by a code fence closed in the wrong place
//   - a "#Heading" run that never became a real heading
//
// See scripts/lib/checkDocsRender.mjs for how each is detected and why.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkSite } from './lib/checkDocsRender.mjs';

const SCOPE = 'check-docs-render';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const { filesChecked, counts, failures } = checkSite(ROOT);

if (filesChecked === 0) {
  console.error(`${SCOPE}: no HTML under site/ -- run \`pnpm docs:build\` first.`);
  process.exit(1);
}

console.log(
  `${SCOPE}: checked ${filesChecked} page(s) -- ` +
    `${counts.admonitions} admonition(s), ${counts.tables} table(s), ` +
    `${counts.codeBlocks} code block(s), ${counts.headings} heading(s).`,
);

if (failures.length > 0) {
  for (const { file, kind, snippet } of failures) {
    console.error(`${SCOPE}: [${kind}] ${file}`);
    console.error(`${SCOPE}:   ${snippet}`);
  }
  console.error(
    `${SCOPE}: ${failures.length} rendering problem(s) found. ` +
      `The build stayed green; the page did not render as written.`,
  );
  process.exit(1);
}

console.log(`${SCOPE}: clean -- every check found what it should have.`);
