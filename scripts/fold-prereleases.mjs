#!/usr/bin/env node
// Fold the pre-release sections of a version back into one released section.
//
// Usage: node scripts/fold-prereleases.mjs <version>
//
// Cutting 1.0.0 after 1.0.0-dev.1, -dev.2 and -rc.1 leaves four changelog
// sections describing one release: three pre-release ones plus whatever
// accumulated in `## Development`. A reader of the released notes wants one.
// This merges them into `## Version <version>`, keeps the subsection grouping,
// drops duplicates, and removes the pre-release sections.
//
// Only the SAME version's pre-releases are folded: 1.0.0-dev.1 goes into 1.0.0
// and never into 1.1.0. That is what stops an entry from an abandoned line
// reappearing under a release it was never part of.
import {
  HARD_LIMIT,
  SOFT_LIMIT,
  escapeForRegExp,
  fail,
  fingerprint,
  groupBullets,
  readChanges,
  splitSections,
  versionFromTag,
  versionHeading,
  warn,
  writeChanges,
} from './lib/changelog.mjs';

const SCOPE = 'fold-prereleases';

const version = versionFromTag(process.argv[2] ?? '');
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  fail(SCOPE, `expected a released version like 1.0.0, got "${process.argv[2] ?? ''}"`);
}

const { head, sections } = splitSections(readChanges());

const isOwnPrerelease = (heading) =>
  new RegExp(`^## Version ${escapeForRegExp(version)}-`).test(heading);
const isDevelopment = (heading) => /^## Development$/.test(heading);
const isTarget = (heading) => versionHeading(version).test(heading);
const isFolded = (heading) =>
  isOwnPrerelease(heading) || isDevelopment(heading) || isTarget(heading);

const folded = sections.filter((section) => isFolded(section.heading));
if (folded.length === 0) fail(SCOPE, 'nothing to fold: no Development and no matching sections');
const prereleaseCount = folded.filter((section) => isOwnPrerelease(section.heading)).length;

// Sections are read in document order, which puts Development first and the
// pre-releases below it, newest to oldest. First occurrence of a duplicate
// wins, so the newest wording of an entry is the one kept.
const merged = new Map();
const seen = new Set();
for (const section of folded) {
  for (const [name, entries] of groupBullets(section.body)) {
    for (const entry of entries) {
      const key = fingerprint(entry);
      if (key === '' || seen.has(key)) continue;
      seen.add(key);
      if (!merged.has(name)) merged.set(name, []);
      merged.get(name).push(entry);
    }
  }
}

const total = [...merged.values()].reduce((sum, entries) => sum + entries.length, 0);
if (total === 0) fail(SCOPE, 'every folded section was empty');
if (total > HARD_LIMIT) {
  fail(
    SCOPE,
    `the folded section would have ${total} entries; the hard limit is ${HARD_LIMIT}. ` +
      'Merge related entries in CHANGES.md before cutting the release.',
  );
}
if (total > SOFT_LIMIT) {
  warn(`${SCOPE}: ${total} entries, over the soft limit of ${SOFT_LIMIT}.`);
}

const body = [...merged.entries()]
  .filter(([, entries]) => entries.length > 0)
  .map(([name, entries]) => [`### ${name}`, '', ...entries.map((e) => e.join('\n'))].join('\n'))
  .join('\n\n');

const kept = sections.filter((section) => !isFolded(section.heading));

writeChanges(
  [
    head.replace(/\n+$/, ''),
    '## Development',
    `## Version ${version}`,
    body,
    ...kept.map((section) => [section.heading, section.body.replace(/\n+$/, '')].join('\n')),
  ]
    .filter((part) => part !== '')
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n'),
);

console.log(
  `${SCOPE}: folded ${prereleaseCount} pre-release section(s) and Development into ` +
    `## Version ${version} (${total} entries)`,
);
