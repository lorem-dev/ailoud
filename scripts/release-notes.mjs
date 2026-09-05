#!/usr/bin/env node
// Extract the CHANGES.md section for a released version into RELEASE_NOTES.md,
// for the GitHub release body.
//
// Usage: node scripts/release-notes.mjs [tag]
// The tag falls back to $GITHUB_REF_NAME; a single leading `v` is stripped.
//
// The heading format is the contract between three things: `bump-version.mjs`
// writes `## Version <v>`, this reads it, and CHANGES.md documents it. Change
// one and the release stops producing notes.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Fails loudly rather than writing empty notes, which nobody would notice. */
function fail(message) {
  console.error(`release-notes: ${message}`);
  process.exit(1);
}

const rawTag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (!rawTag) fail('no tag given (pass one, or set $GITHUB_REF_NAME)');
const version = rawTag.replace(/^v/, '');

const lines = readFileSync(join(root, 'CHANGES.md'), 'utf8').split('\n');

// Tolerates a trailing ` -- <date>` after the version.
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const heading = new RegExp(`^## Version ${escaped}(\\s|$)`);

const start = lines.findIndex((line) => heading.test(line));
if (start === -1) fail(`no "## Version ${version}" section in CHANGES.md`);

let end = lines.length;
for (let at = start + 1; at < lines.length; at += 1) {
  if (lines[at].startsWith('## ')) {
    end = at;
    break;
  }
}

const body = lines
  .slice(start + 1, end)
  .join('\n')
  .trim();
if (body === '') fail(`the section for ${version} is empty`);

// The limits CHANGES.md and AGENTS.md state, enforced here because this is the
// last point before the notes reach anyone. A release that quietly shipped 90
// entries would have been reviewed by nobody.
const bullets = body.split('\n').filter((line) => /^\s*- /.test(line)).length;
if (bullets > 50) {
  fail(
    `the section for ${version} has ${bullets} entries; the hard limit is 50. ` +
      'Merge related entries, or cut what does not affect a user.',
  );
}
if (bullets > 10) {
  console.error(
    `release-notes: warning: ${bullets} entries, over the soft limit of 10. ` +
      'Worth a look for entries to merge before tagging.',
  );
}

writeFileSync(join(root, 'RELEASE_NOTES.md'), `${body}\n`);
console.log(body);
