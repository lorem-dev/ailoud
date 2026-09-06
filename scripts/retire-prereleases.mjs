#!/usr/bin/env node
// Retire the pre-releases of a version once its final release is out.
//
// Usage: NPM_TOKEN=npm_... node scripts/retire-prereleases.mjs <version> [--yes]
//
// ONE authentication for the whole run. With 2FA in "authorization and writes"
// mode -- the default -- npm asks for a one-time code on every write, and this
// makes ten of them: nine deprecations and one dist-tag. A granular access
// token with read-and-write on the packages bypasses 2FA, and every npm call
// here goes through a single temporary npmrc holding it, so it is entered once
// and never reaches a command line.
//
// Without NPM_TOKEN it falls back on the ambient `npm login`, which works and
// will prompt ten times.
//
// Run from a laptop. `AILOUD_PACKUMENTS` points at a JSON fixture instead of
// the registry, which is how the tests stay off the network. NOT from CI, and not because nobody
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
// WHY THE `dev` DIST-TAG MOVES RATHER THAN GOING AWAY
//
// Removing it makes `npm install <pkg>@dev` fail outright for anyone who uses
// it. Pointing it at the release keeps it working and keeps its meaning: `dev`
// is the newest thing to try, and after a release that is the release.
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
import { readFileSync } from 'node:fs';
import { PACKAGES, fail, planRetirement, versionFromTag, warn } from './lib/changelog.mjs';
import { withNpmToken } from './lib/npmOidc.mjs';

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

/**
 * The pre-releases of `version` that a package actually has on npm.
 *
 * From the registry, not from git tags. The tags used to be the list, which
 * made them the only record of what still needed retiring -- and a tag is a
 * thing that gets deleted. The registry cannot forget what it published, and
 * reading it needs no credential.
 */
const REGISTRY = 'https://registry.npmjs.org';

/**
 * The registry's document for a package.
 *
 * `AILOUD_PACKUMENTS` points at a JSON file of `{ "<package>": <packument> }`
 * and is how the tests answer this without the network. A file rather than a
 * stub server on a port: a server is a live handle, and a test that throws
 * before closing it hangs the whole run with no failing test to show for it.
 * That happened, and cost an afternoon.
 */
async function packumentOf(pkg) {
  const fixture = process.env.AILOUD_PACKUMENTS;
  if (fixture !== undefined && fixture !== '') {
    const all = JSON.parse(readFileSync(fixture, 'utf8'));
    if (!Object.hasOwn(all, pkg)) fail(SCOPE, `${fixture} has no entry for ${pkg}`);
    return all[pkg];
  }
  const response = await fetch(`${REGISTRY}/${pkg.replaceAll('/', '%2f')}`);
  if (!response.ok) fail(SCOPE, `the registry answered ${response.status} for ${pkg}`);
  return response.json();
}

/**
 * What is left to do for one package: which pre-releases still need
 * deprecating, and whether `dev` still points somewhere else.
 *
 * Both questions are asked of the registry, so a second run is quiet and a
 * half-finished first run can simply be repeated. `npm deprecate` on an
 * already-deprecated version succeeds and re-sends the same message, which
 * would make a re-run look like it did work it did not.
 */
async function outstandingFor(pkg) {
  const { versions: published, 'dist-tags': distTags } = await packumentOf(pkg);
  const prereleases = Object.keys(published)
    .filter((candidate) => candidate.startsWith(`${version}-`))
    .sort();
  // Truthiness, deliberately, and it agrees with `isDeprecated` in
  // packages/providers for every shape npm actually sends: the field holds the
  // deprecation MESSAGE, so an empty string -- what `npm deprecate <pkg>@<v>
  // ""` writes to un-deprecate -- is falsy and correctly reads as live.
  //
  // NOT importing that function on purpose. It would mean importing from
  // `packages/providers/dist`, and this script is run to finish a RELEASE:
  // coupling it to a build artefact buys a failure at import time, before it
  // can even print its plan, in exchange for removing an agreement that is
  // already correct. On the invented shapes where the two could differ (an
  // object, say) this script's answer is "deprecate it again", which is
  // idempotent and harmless.
  const isDeprecatedHere = (v) => Boolean(published[v].deprecated);
  return {
    deprecate: prereleases.filter((v) => !isDeprecatedHere(v)),
    alreadyDeprecated: prereleases.filter(isDeprecatedHere),
    // Also true when `dev` is absent. A missing dist-tag is not "nothing to
    // do": `npm install <pkg>@dev` fails outright without it, which is the
    // breakage that moving it instead of removing it exists to avoid -- and
    // an earlier version of this script removed it on one package.
    devNeedsSetting: distTags?.dev !== version,
    published: Object.hasOwn(published, version),
  };
}

const perPackage = new Map();
for (const pkg of PACKAGES) perPackage.set(pkg, await outstandingFor(pkg));

const missing = [...perPackage].filter(([, work]) => !work.published).map(([pkg]) => pkg);
if (missing.length > 0) {
  fail(
    SCOPE,
    `${missing.join(', ')} has no ${version} published. Retiring the snapshots it supersedes ` +
      'would deprecate them in favour of something that does not exist.',
  );
}

const total = [...perPackage.values()].reduce((sum, work) => sum + work.deprecate.length, 0);
const settled = [...perPackage.values()].reduce(
  (sum, work) => sum + work.alreadyDeprecated.length,
  0,
);
const devToMove = [...perPackage].filter(([, work]) => work.devNeedsSetting).map(([pkg]) => pkg);

const tags = git(['tag', '--list', `v${version}-*`])
  .split('\n')
  .filter(Boolean);
const onMain = (tag) =>
  spawnSync('git', ['merge-base', '--is-ancestor', tag, 'origin/main'], { encoding: 'utf8' })
    .status === 0;

const { deletable, kept } = planRetirement(version, tags, onMain);

if (settled > 0) {
  console.log(`${SCOPE}: ${settled} version(s) are already deprecated; leaving them alone.`);
}

if (total === 0 && devToMove.length === 0 && deletable.length === 0) {
  console.log(`${SCOPE}: nothing left to retire for ${version}.`);
  process.exit(0);
}

console.log(`${SCOPE}: ${total} version(s) to deprecate for ${version}`);
for (const [pkg, work] of perPackage) {
  for (const prerelease of work.deprecate) console.log(`  deprecate ${pkg}@${prerelease}`);
}
// Moved, not removed. `npm dist-tag rm <pkg> dev` leaves `@dev` unresolvable,
// which breaks anyone who installs it; pointing it at the release means `@dev`
// never hands out something older than `latest`.
for (const pkg of devToMove) console.log(`  point the "dev" dist-tag at ${pkg}@${version}`);
for (const tag of deletable) console.log(`  delete tag ${tag} (local and origin)`);
for (const tag of kept) {
  warn(
    `${SCOPE}: keeping ${tag} -- its commit is not reachable from origin/main, and deleting ` +
      'the tag could orphan the commit the published provenance attests.',
  );
}

const token = process.env.NPM_TOKEN ?? '';

/**
 * Runs every npm call of this run under one credential.
 *
 * `npmEnv` is prepared once, so the temporary npmrc is written once and torn
 * down once -- a per-call `withNpmToken` would be ten files and ten chances to
 * leave one behind.
 */
function npm(args, env) {
  // stdin closed. Without a usable credential npm falls into its interactive
  // web-auth flow -- "Open this URL in your browser to authenticate" -- and
  // with an inherited stdin it waits there forever. A release script must fail
  // and say why instead of hanging; this turns the prompt into an error.
  return spawnSync('npm', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'inherit', 'inherit'],
    env,
  });
}

/**
 * Calls `body(env)` with one credential in place for the whole run.
 *
 * NPM_TOKEN is REQUIRED, not preferred. Falling back on the ambient `npm
 * login` sounds accommodating and is not: with 2FA on writes -- the default --
 * npm asks for a one-time code on every single write, and this makes twelve of
 * them. Worse, without a usable credential npm drops into its interactive
 * web-auth flow and waits, so the script appears to hang.
 *
 * Refusing up front is the difference between one authentication and twelve
 * prompts, and between a clear error and something that looks broken.
 */
function withCredential(body) {
  if (token === '') {
    fail(
      SCOPE,
      'NPM_TOKEN is not set, and npm would ask for a 2FA code on every one of the writes ' +
        'below -- or wait on an interactive login. Create a granular access token with ' +
        'read-and-write on @ailoud/core, @ailoud/providers and ailoud, then re-run:\n' +
        '  NPM_TOKEN=npm_... pnpm retire <version> --yes',
    );
  }
  console.log(`${SCOPE}: one credential from NPM_TOKEN for every call in this run.`);
  return withNpmToken(token, body);
}

if (!confirmed) {
  console.log(`${SCOPE}: nothing was changed. Re-run with --yes to carry this out.`);
  process.exit(0);
}

// Everything that did not happen. Collected rather than warned about and
// forgotten, because the tag deletion below is the irreversible half and only
// worth doing if the npm half actually took.
const problems = withCredential((env) => {
  const failures = [];
  for (const [pkg, work] of perPackage) {
    for (const prerelease of work.deprecate) {
      const result = npm(['deprecate', `${pkg}@${prerelease}`, `superseded by ${version}`], env);
      if (result.status !== 0) failures.push(`could not deprecate ${pkg}@${prerelease}`);
    }
  }
  for (const pkg of devToMove) {
    if (npm(['dist-tag', 'add', `${pkg}@${version}`, 'dev'], env).status !== 0) {
      failures.push(`could not point the "dev" dist-tag at ${pkg}@${version}`);
    }
  }
  return failures;
});

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
