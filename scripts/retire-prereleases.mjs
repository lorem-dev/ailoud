#!/usr/bin/env node
// Retire the pre-releases of a version once its final release is out.
//
// Usage: node scripts/retire-prereleases.mjs <version> [--yes]
//
// Run from a laptop, under `npm login`. NOT from CI, and not because nobody
// wired it up: trusted publishing authenticates `npm publish` and nothing
// else. Exchanging the OIDC identity for a token does work -- npm's own client
// does it -- but the token it returns cannot deprecate. Measured on the 1.0.0
// release, where the first call answered
//   E404 ... or you do not have permission
// and every call after it
//   E401 ... token is invalid
// so the token is publish-scoped and spent. This file said so before the
// automation was attempted; the release settled it.
//
// Prints the plan and changes nothing without --yes. Two of the three actions
// cannot be undone, so consent is explicit here for the same reason it is in
// `setup` and `rm`.
//
// WHY DEPRECATE AND NOT UNPUBLISH
//
// npm allows unpublish only within 72 hours, a version number can never be
// reused afterwards, and anyone who pinned the version has their install
// broken. Deprecating leaves every existing install working and prints a
// notice on the next one, which is what "this is superseded" should mean.
//
// WHY ONLY SOME GIT TAGS ARE DELETED
//
// A published package's provenance names both the commit and the tag it was
// built from. Deleting a tag whose commit is reachable from main costs only the
// name: verification needs the commit, and main keeps it alive. Deleting a tag
// that holds the only reference to its commit lets the commit be collected,
// which costs the attestation its subject -- so those tags are reported and
// left alone.
import { spawnSync } from 'node:child_process';
import { PACKAGES, fail, planRetirement, versionFromTag, warn } from './lib/changelog.mjs';

const SCOPE = 'retire-prereleases';

const version = versionFromTag(process.argv[2] ?? '');
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  fail(SCOPE, `expected a released version like 1.0.0, got "${process.argv[2] ?? ''}"`);
}
const confirmed = process.argv.includes('--yes');

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) fail(SCOPE, `git ${args.join(' ')} failed: ${result.stderr?.trim()}`);
  return result.stdout ?? '';
}

const tags = git(['tag', '--list', `v${version}-*`])
  .split('\n')
  .filter(Boolean);
const onMain = (tag) =>
  spawnSync('git', ['merge-base', '--is-ancestor', tag, 'origin/main'], { encoding: 'utf8' })
    .status === 0;

const { versions, deletable, kept } = planRetirement(version, tags, onMain);

if (versions.length === 0) {
  console.log(`${SCOPE}: no pre-release tags for ${version}; nothing to retire.`);
  process.exit(0);
}

console.log(`${SCOPE}: retiring ${versions.length} pre-release(s) of ${version}`);
for (const prerelease of versions) {
  for (const pkg of PACKAGES) {
    console.log(`  deprecate ${pkg}@${prerelease}`);
  }
}
console.log(`  drop the "dev" dist-tag from ${PACKAGES.at(-1)}`);
for (const tag of deletable) console.log(`  delete tag ${tag} (local and origin)`);
for (const tag of kept) {
  warn(
    `${SCOPE}: keeping ${tag} -- its commit is not reachable from origin/main, and deleting ` +
      'the tag could orphan the commit the published provenance attests.',
  );
}

/** Runs npm under whatever credentials the machine already has. */
function npm(args) {
  return spawnSync('npm', args, { encoding: 'utf8', stdio: 'inherit' });
}

if (!confirmed) {
  console.log(`${SCOPE}: nothing was changed. Re-run with --yes to carry this out.`);
  process.exit(0);
}

// Everything that did not happen. Collected rather than warned about and
// forgotten, because the tag deletion below is the irreversible half and only
// worth doing if the npm half actually took.
const problems = [];

for (const pkg of PACKAGES) {
  for (const prerelease of versions) {
    const result = npm(['deprecate', `${pkg}@${prerelease}`, `superseded by ${version}`]);
    if (result.status !== 0) problems.push(`could not deprecate ${pkg}@${prerelease}`);
  }
}

// The `dev` dist-tag still points at the last snapshot, so `npm install
// ailoud@dev` would hand out something older than `latest`.
const cli = PACKAGES.at(-1);
if (npm(['dist-tag', 'rm', cli, 'dev']).status !== 0) {
  problems.push('could not drop the "dev" dist-tag');
}

if (problems.length > 0) {
  for (const problem of problems) warn(`${SCOPE}: ${problem}`);
  // Refusing here is the whole point. Deleting the tags anyway would leave the
  // versions installable and undeprecated, `dev` pointing at a snapshot, and
  // nothing left to name what was missed -- on a green release run, because
  // warnings do not fail anything.
  fail(
    SCOPE,
    `${problems.length} thing(s) above did not happen on npm, so the tags are left in place. ` +
      'Fix the cause and re-run; nothing here has to be undone first.',
  );
}

// origin first, then locally. The remote is the copy others fetch, and the
// local one is what names the tag on a re-run: deleting locally first and
// failing to push left the tag on origin with nothing here to retry it by.
let undeleted = 0;
for (const tag of deletable) {
  const pushed = spawnSync('git', ['push', 'origin', `:refs/tags/${tag}`], { encoding: 'utf8' });
  if (pushed.status !== 0) {
    warn(`${SCOPE}: could not delete ${tag} on origin: ${pushed.stderr?.trim()}`);
    undeleted += 1;
    continue;
  }
  git(['tag', '-d', tag]);
}

if (undeleted > 0) {
  fail(SCOPE, `${undeleted} tag(s) are still on origin. The npm side is done; re-run to finish.`);
}

console.log(`${SCOPE}: done.`);
