#!/usr/bin/env node
// Refuse dependency versions that are too fresh to trust.
//
// Usage: node scripts/check-dependency-age.mjs [--days 14]
//
// WHY
//
// A compromised release is discovered by other people, and that takes days:
// the npm supply-chain incidents of recent years were all caught within a week
// or two of publication, after the malicious version had already been installed
// by everyone who upgraded immediately. Waiting is the whole mitigation, and it
// costs nothing -- there is no urgency in a patch that has been out for two
// weeks that was not there on day one.
//
// Checked against the version each manifest PINS, not what is installed: this
// project pins exact versions, so the manifest is the decision and the lockfile
// only records it. A spec that is not an exact version is reported rather than
// aged, because a range means the decision was left to whatever resolved last.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapePackageName } from './lib/npmOidc.mjs';
import {
  DEFAULT_DAYS,
  EXACT,
  classify,
  collectDependencies,
  staleExceptions,
} from './lib/dependencyAge.mjs';

const SCOPE = 'check-dependency-age';
const REGISTRY = 'https://registry.npmjs.org';
const EXCEPTIONS = 'scripts/dependency-age-exceptions.json';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

/**
 * When `version` was published, or null if the registry does not know.
 *
 * A 404 means the registry has no such package, which is a real answer. Any
 * other refusal -- a 429, a 502 -- is the registry declining to answer, and
 * returning null for it turned this whole check into a no-op that reported
 * success: every entry became "unknown", nothing was young, exit 0. So those
 * throw, and the rule fails closed.
 */
async function publishedAt(name, version) {
  const response = await fetch(`${REGISTRY}/${escapePackageName(name)}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`the registry answered ${response.status} for ${name}; cannot judge its age`);
  }
  const { time } = await response.json();
  const stamp = time?.[version];
  if (typeof stamp !== 'string') return null;
  const parsed = Date.parse(stamp);
  // An unparseable timestamp is not an age. Reported as unknown rather than
  // compared as NaN, which produced "published NaN days ago".
  return Number.isFinite(parsed) ? parsed : null;
}

const daysFlag = process.argv.indexOf('--days');
const days = daysFlag === -1 ? DEFAULT_DAYS : Number(process.argv[daysFlag + 1]);
if (!Number.isFinite(days) || days < 0) {
  console.error(`${SCOPE}: --days needs a non-negative number`);
  process.exit(1);
}

const exceptions = existsSync(join(root, EXCEPTIONS)) ? JSON.parse(read(EXCEPTIONS)) : {};
const dependencies = collectDependencies(read);
const unpinned = [...dependencies].filter(([, spec]) => !EXACT.test(spec));
const pinned = [...dependencies].filter(([, spec]) => EXACT.test(spec));

const entries = await Promise.all(
  pinned.map(async ([name, spec]) => [name, spec, await publishedAt(name, spec)]),
);
const now = Date.now();
const { young, exempt, unknown } = classify(entries, now, days, exceptions);

console.log(`${SCOPE}: ${pinned.length} pinned direct dependencies, minimum age ${days} days`);

for (const [name, spec] of unpinned) {
  console.log(`  ${name}@${spec} is not an exact version; its age was not checked`);
}
for (const { name, spec } of unknown) {
  console.log(`  ${name}@${spec}: the registry reported no publish time`);
}
for (const { name, spec, ageDays, reason } of exempt) {
  console.log(`  ${name}@${spec} is ${ageDays.toFixed(1)} days old, allowed: ${reason}`);
}
for (const key of staleExceptions(exceptions, entries, now, days)) {
  // Not a failure: a hole that has closed is only clutter. Left unreported it
  // would still be there the next time something needed exempting.
  console.log(`  ${EXCEPTIONS} no longer needs its entry for ${key}`);
}

if (young.length === 0) {
  console.log(`${SCOPE}: nothing newer than ${days} days.`);
  process.exit(0);
}

for (const { name, spec, ageDays } of young) {
  console.error(`${SCOPE}: ${name}@${spec} was published ${ageDays.toFixed(1)} days ago`);
}
console.error(
  `${SCOPE}: wait until each is ${days} days old, or pin the previous version. ` +
    'A compromised release is found by other people, and that takes days. ' +
    `If one fixes a critical advisory, add it to ${EXCEPTIONS} with the advisory ID.`,
);
process.exit(1);
