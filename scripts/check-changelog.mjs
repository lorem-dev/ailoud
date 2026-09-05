#!/usr/bin/env node
// Verify CHANGES.md is fit to release a given tag.
//
// Usage: node scripts/check-changelog.mjs <tag>
// The tag falls back to $GITHUB_REF_NAME; a single leading `v` is stripped.
//
// Run on every tag before anything is published. A version number can never
// be reused and the unpublish window is 72 hours, so the changelog is worth
// checking while refusing is still free.
import {
  HARD_LIMIT,
  SOFT_LIMIT,
  baseVersion,
  countBullets,
  escapeForRegExp,
  fail,
  isPrerelease,
  readChanges,
  splitSections,
  versionFromTag,
  versionHeading,
  warn,
} from './lib/changelog.mjs';

const SCOPE = 'check-changelog';

const rawTag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (!rawTag) fail(SCOPE, 'no tag given (pass one, or set $GITHUB_REF_NAME)');

const version = versionFromTag(rawTag);
const { sections } = splitSections(readChanges());

// Collected rather than thrown one at a time: someone fixing a changelog
// before a release wants the whole list, not one round trip per problem.
const problems = [];

const own = sections.find((section) => versionHeading(version).test(section.heading));
if (own === undefined) {
  problems.push(`no "## Version ${version}" section. Promote it with bump-version first.`);
}

const entries = own === undefined ? 0 : countBullets(own.body);
if (own !== undefined && entries === 0) {
  problems.push(`the "## Version ${version}" section has no entries.`);
}
if (entries > HARD_LIMIT) {
  problems.push(
    `${entries} entries in this version; the hard limit is ${HARD_LIMIT}. Merge or cut some.`,
  );
}

// A final tag must not leave its own pre-release sections behind: they
// describe the same release, and a reader of 1.0.0's notes should not have to
// read 1.0.0-dev.1's as well. fold-prereleases exists to merge them.
if (!isPrerelease(version)) {
  const base = baseVersion(version);
  const leftovers = sections
    .map((section) => section.heading)
    .filter((heading) => new RegExp(`^## Version ${escapeForRegExp(base)}-`).test(heading));
  if (leftovers.length > 0) {
    problems.push(
      `${leftovers.length} pre-release section(s) for ${base} are still present ` +
        `(${leftovers.map((h) => h.replace('## Version ', '')).join(', ')}). ` +
        `Run: node scripts/fold-prereleases.mjs ${base}`,
    );
  }
}

// Nothing may be stranded in Development at release time: an entry left there
// is a change that shipped and went unmentioned.
const development = sections.find((section) => /^## Development$/.test(section.heading));
if (development !== undefined) {
  const stranded = countBullets(development.body);
  if (stranded > 0) {
    problems.push(
      `${stranded} entr${stranded === 1 ? 'y is' : 'ies are'} still under "## Development".`,
    );
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`${SCOPE}: ${problem}`);
  process.exit(1);
}

if (entries > SOFT_LIMIT) {
  warn(`${SCOPE}: ${entries} entries, over the soft limit of ${SOFT_LIMIT}.`);
}
console.log(`${SCOPE}: ${version} is ready (${entries} entries).`);
