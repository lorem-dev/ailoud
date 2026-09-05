#!/usr/bin/env node
// Bump the ailoud version across every package.json and promote the
// CHANGES.md changelog. Requires a clean working tree so the bump is
// reviewable as an isolated diff.
// Usage: node scripts/bump-version.mjs <version>
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A quick, local command; a few seconds is already generous. */
const GIT_STATUS_TIMEOUT_MS = 10_000;

// JSON manifests carrying a "version" field: the root and the three
// workspace packages (packages/core, packages/providers, apps/cli). There
// is no Cargo.toml and no tauri.conf.json in this project.
const PACKAGE_FILES = [
  'package.json',
  'packages/core/package.json',
  'packages/providers/package.json',
  'apps/cli/package.json',
];

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function fail(msg) {
  console.error(`bump-version: ${msg}`);
  process.exit(1);
}

// 0. Require a clean working tree so the bump is reviewable as an
//    isolated diff.
let status;
try {
  status = execFileSync('git', ['status', '--porcelain'], {
    cwd: root,
    encoding: 'utf8',
    timeout: GIT_STATUS_TIMEOUT_MS,
  });
} catch (error) {
  fail(`could not read git status: ${error.message}`);
}
if (status.trim() !== '') {
  fail('working tree is not clean; commit or stash pending changes first');
}

const version = process.argv[2];
if (!version) fail('usage: node scripts/bump-version.mjs <version>');
if (!SEMVER.test(version)) fail(`invalid semver: ${version}`);

// 1. Update every package.json version, preserving the existing formatting.
for (const rel of PACKAGE_FILES) {
  const path = join(root, rel);
  const text = readFileSync(path, 'utf8');
  const next = text.replace(/^(\s*"version":\s*)"[^"]*"/m, `$1"${version}"`);
  if (next === text) fail(`no version field updated in ${rel}`);
  writeFileSync(path, next);
  console.log(`updated ${rel} -> ${version}`);
}

// 2. Promote CHANGES.md: move the current `## Development` entries into a
//    new `## Version <v>` section and leave a fresh, empty `## Development`
//    heading above it. Empty `### ` subsections are omitted entirely, so
//    the release notes carry only sections that have content.
const changesPath = join(root, 'CHANGES.md');
const changes = readFileSync(changesPath, 'utf8');
const lines = changes.split('\n');

const devIdx = lines.findIndex((line) => /^## Development$/.test(line));
if (devIdx === -1) fail('CHANGES.md has no `## Development` section to promote');

let nextIdx = lines.length;
for (let i = devIdx + 1; i < lines.length; i++) {
  if (lines[i].startsWith('## ')) {
    nextIdx = i;
    break;
  }
}

const headText = lines.slice(0, devIdx).join('\n').replace(/\n+$/, '');
const devBody = lines.slice(devIdx + 1, nextIdx).join('\n');
const tailText = lines.slice(nextIdx).join('\n').replace(/^\n+/, '');

function stripEmptySections(body) {
  const bodyLines = body.split('\n');
  const out = [];
  let i = 0;
  while (i < bodyLines.length) {
    if (bodyLines[i].startsWith('### ')) {
      let j = i + 1;
      while (
        j < bodyLines.length &&
        !bodyLines[j].startsWith('### ') &&
        !bodyLines[j].startsWith('## ')
      ) {
        j++;
      }
      const content = bodyLines
        .slice(i + 1, j)
        .join('\n')
        .trim();
      if (content !== '' && content !== '- None.') out.push(...bodyLines.slice(i, j));
      i = j;
    } else {
      out.push(bodyLines[i]);
      i++;
    }
  }
  return out.join('\n');
}

const promotedBody = stripEmptySections(devBody)
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const parts = [headText, '## Development', `## Version ${version}`];
if (promotedBody) parts.push(promotedBody);

let rebuilt = parts.join('\n\n');
if (tailText) rebuilt += '\n\n' + tailText;
rebuilt = rebuilt.replace(/\s+$/, '') + '\n';

writeFileSync(changesPath, rebuilt);
console.log(`promoted CHANGES.md -> ## Version ${version}`);
