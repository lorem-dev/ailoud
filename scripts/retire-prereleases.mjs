#!/usr/bin/env node
// Retire the pre-releases of a version once its final release is out.
//
// Usage: node scripts/retire-prereleases.mjs <version> [--yes]
//
// Authenticates by exchanging the CI OIDC identity for a per-package npm token
// when it runs in GitHub Actions with `id-token: write`, and otherwise leaves
// npm to its ambient login -- so this needs no stored credential in CI and
// still works from a laptop. Without --yes it exchanges nothing but reports
// whether it could, which makes the dry run a real check of the credential
// path rather than a guess about it.
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
import { canExchange, tokenForPackage, withNpmToken } from './lib/npmOidc.mjs';

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

/** A token for one package, or null to fall back on npm's ambient login. */
async function credentialFor(pkg) {
  if (!canExchange()) return null;
  return tokenForPackage(pkg);
}

/** Runs npm with the exchanged token when there is one, plainly when not. */
function npm(args, token) {
  const run = (env) => spawnSync('npm', args, { encoding: 'utf8', stdio: 'inherit', env });
  return token === null ? run(process.env) : withNpmToken(token, run);
}

if (!confirmed) {
  if (canExchange()) {
    // Mints a token and uses it for nothing. The exchange is the step that
    // fails when a trusted publisher is missing, so proving it works is worth
    // more here than a message saying it should.
    for (const pkg of PACKAGES) {
      const token = await tokenForPackage(pkg);
      console.log(`  credential for ${pkg}: ${token === null ? 'NOT AVAILABLE' : 'ok'}`);
    }
  }
  console.log(`${SCOPE}: nothing was changed. Re-run with --yes to carry this out.`);
  process.exit(0);
}

for (const pkg of PACKAGES) {
  const token = await credentialFor(pkg);
  if (token === null && canExchange()) {
    warn(`${SCOPE}: no credential for ${pkg}; its versions stay as they are`);
    continue;
  }
  for (const prerelease of versions) {
    const result = npm(['deprecate', `${pkg}@${prerelease}`, `superseded by ${version}`], token);
    // Reported, not fatal: a pre-release that was never published to one of
    // the three packages is normal, and stopping here would leave the rest
    // half-retired.
    if (result.status !== 0) warn(`${SCOPE}: could not deprecate ${pkg}@${prerelease}`);
  }
}

// The `dev` dist-tag still points at the last snapshot, so `npm install
// ailoud@dev` would hand out something older than `latest`.
const cli = PACKAGES.at(-1);
const dropped = npm(['dist-tag', 'rm', cli, 'dev'], await credentialFor(cli));
if (dropped.status !== 0) warn(`${SCOPE}: could not drop the "dev" dist-tag`);

for (const tag of deletable) {
  git(['tag', '-d', tag]);
  const pushed = spawnSync('git', ['push', 'origin', `:refs/tags/${tag}`], { encoding: 'utf8' });
  if (pushed.status !== 0) warn(`${SCOPE}: could not delete ${tag} on origin`);
}

console.log(`${SCOPE}: done.`);
