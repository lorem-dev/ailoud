// Shared vocabulary for the release scripts: the limits, the two ways of
// reporting, and the CHANGES.md parsing all three of them need.
//
// Extracted because the numbers and the parsing were copied into every script
// that touched the changelog. Copied limits drift, and a limit that differs
// between the script that warns and the script that refuses is worse than no
// limit -- one of them is then wrong and nobody knows which.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The published packages, in dependency order.
 *
 * The CLI is last because the other two are its dependencies: publish and
 * deprecate both have to walk them in this order.
 */
export const PACKAGES = ['@ailoud/core', '@ailoud/providers', 'ailoud'];

/**
 * Which pre-release tags belong to a released version, and which may be deleted.
 *
 * Pure: it takes the tag list and an "is this commit on main" predicate rather
 * than running git, so the decision is testable without a repository.
 */
export function planRetirement(version, tags, isOnMain) {
  const prefix = `v${version}-`;
  const mine = tags.filter((tag) => tag.startsWith(prefix)).sort();
  return {
    versions: mine.map((tag) => versionFromTag(tag)),
    deletable: mine.filter((tag) => isOnMain(tag)),
    kept: mine.filter((tag) => !isOnMain(tag)),
  };
}

/** Entries per version section. Stated once here, quoted in AGENTS.md and CHANGES.md. */
export const SOFT_LIMIT = 10;
export const HARD_LIMIT = 50;

/** Where the repository root is, relative to scripts/lib/. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CHANGES_PATH = join(ROOT, 'CHANGES.md');

/** Stops with a message the caller owns. */
export function fail(scope, message) {
  console.error(`${scope}: ${message}`);
  process.exit(1);
}

/**
 * A warning, not an error.
 *
 * `console.error` made a soft-limit notice look like a failure in a terminal
 * and in a CI log alike. Under GitHub Actions this becomes an annotation,
 * which is what a warning should be there.
 */
export function warn(message) {
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log(`::warning::${message}`);
    return;
  }
  console.warn(message);
}

/** `v1.2.3` and `1.2.3` both mean 1.2.3. */
export function versionFromTag(tag) {
  return String(tag).replace(/^v/, '');
}

/** The release part of a version: `1.0.0-dev.2` -> `1.0.0`. */
export function baseVersion(version) {
  return version.split('-')[0];
}

export function isPrerelease(version) {
  return version.includes('-');
}

/** Safe inside a RegExp built from a version string. */
export function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function readChanges() {
  return readFileSync(CHANGES_PATH, 'utf8');
}

export function writeChanges(text) {
  writeFileSync(CHANGES_PATH, `${text.trimEnd()}\n`);
}

/** Every `## ` section as {heading, body}, plus whatever precedes the first one. */
export function splitSections(text) {
  const lines = text.split('\n');
  const starts = [];
  lines.forEach((line, at) => {
    if (line.startsWith('## ')) starts.push(at);
  });
  const head = lines.slice(0, starts[0] ?? lines.length).join('\n');
  const sections = starts.map((start, index) => ({
    heading: lines[start],
    body: lines.slice(start + 1, starts[index + 1] ?? lines.length).join('\n'),
  }));
  return { head, sections };
}

/**
 * Bullets of a section body, grouped by their `### ` subsection.
 *
 * A continuation line is attached to the bullet above it rather than dropped,
 * which is what keeps an 80-column entry whole -- every wrapped entry would
 * otherwise lose everything after its first line.
 */
export function groupBullets(body) {
  const groups = new Map();
  let current = 'Added';
  for (const line of body.split('\n')) {
    if (line.startsWith('### ')) {
      current = line.slice(4).trim();
      if (!groups.has(current)) groups.set(current, []);
      continue;
    }
    if (/^\s*- /.test(line)) {
      if (!groups.has(current)) groups.set(current, []);
      groups.get(current).push([line]);
      continue;
    }
    const entries = groups.get(current);
    if (entries !== undefined && entries.length > 0 && line.trim() !== '') {
      entries[entries.length - 1].push(line);
    }
  }
  return groups;
}

export function countBullets(body) {
  return body.split('\n').filter((line) => /^\s*- /.test(line)).length;
}

/** Whitespace-insensitive, so the same entry rewrapped is still the same entry. */
export function fingerprint(entry) {
  return entry.join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The body of the section whose heading matches, or null. */
export function findSection(sections, pattern) {
  return sections.find((section) => pattern.test(section.heading)) ?? null;
}

export function versionHeading(version) {
  return new RegExp(`^## Version ${escapeForRegExp(version)}(\\s|$)`);
}
