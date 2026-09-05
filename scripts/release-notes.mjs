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
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HARD_LIMIT,
  ROOT,
  SOFT_LIMIT,
  countBullets,
  fail,
  readChanges,
  splitSections,
  versionFromTag,
  versionHeading,
  warn,
} from './lib/changelog.mjs';

const SCOPE = 'release-notes';

const rawTag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (!rawTag) fail(SCOPE, 'no tag given (pass one, or set $GITHUB_REF_NAME)');
const version = versionFromTag(rawTag);

const { sections } = splitSections(readChanges());
const own = sections.find((section) => versionHeading(version).test(section.heading));
if (own === undefined) fail(SCOPE, `no "## Version ${version}" section in CHANGES.md`);

const body = own.body.trim();
if (body === '') fail(SCOPE, `the section for ${version} is empty`);

// The limits CHANGES.md and AGENTS.md state, enforced here because this is
// the last point before the notes reach anyone. A release that quietly
// shipped 90 entries would have been reviewed by nobody.
const bullets = countBullets(body);
if (bullets > HARD_LIMIT) {
  fail(
    SCOPE,
    `the section for ${version} has ${bullets} entries; the hard limit is ${HARD_LIMIT}. ` +
      'Merge related entries, or cut what does not affect a user.',
  );
}
if (bullets > SOFT_LIMIT) {
  warn(
    `${SCOPE}: ${bullets} entries, over the soft limit of ${SOFT_LIMIT}. ` +
      'Worth a look for entries to merge before tagging.',
  );
}

writeFileSync(join(ROOT, 'RELEASE_NOTES.md'), `${body}\n`);
console.log(body);
