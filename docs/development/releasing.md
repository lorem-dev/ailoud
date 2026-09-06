# Releasing

## Branches

| Branch           | Is                                      |
| ---------------- | --------------------------------------- |
| `main`           | the release branch                      |
| `develop`        | integration; feature branches land here |
| `feature/<name>` | feature work, branched from `develop`   |

## Tags

| Tag                  | Means                                    | npm dist-tag |
| -------------------- | ---------------------------------------- | ------------ |
| `v<version>-dev.<n>` | a snapshot, tagged on any branch         | `dev`        |
| `v<version>-rc.<n>`  | a release candidate, tagged on `develop` | `next`       |
| `v<version>`         | a final release, tagged on `main` only   | `latest`     |

Only a final tag moves `latest`, so `npm install ailoud` never returns a
pre-release -- except for a package's very first publish, where npm sets
`latest` whatever `--tag` says. `latest` can be moved but not removed, so that
first pre-release answers `npm install ailoud` until a final version exists.

## Changelog limits

`CHANGES.md` has a soft limit of 10 entries per version and a hard limit of 50.
`scripts/release-notes.mjs` warns past the first and refuses past the second.

Entries describe what a user can now do, or what changed under them. Anything
fixed before it shipped is left out entirely -- if no released version had the
bug, there is nothing to say. See
[AGENTS.md](https://github.com/lorem-dev/ailoud/blob/main/AGENTS.md).

## Steps

1. Run the `pre-release-check` skill. It runs the whole gate plus the
   documentation, dependency, changelog and version checks.

2. Run the `bump-version` skill. It sets the version across every
   `package.json` and promotes the CHANGES.md Development section. It does not
   tag or push.

3. Fold the pre-release sections in. `bump-version` comes first:

   ```
   node scripts/fold-prereleases.mjs 1.2.3
   node scripts/check-changelog.mjs v1.2.3
   ```

   Folding first would leave `bump-version` an empty Development section to
   promote, giving a second `## Version 1.2.3` heading that fails the check.

   To read the notes as they will appear, `node scripts/release-notes.mjs
v1.2.3` writes them to `RELEASE_NOTES.md`. The release itself does not need
   this -- `publish.yml` runs the same script.

4. Commit, tag and push:

   ```
   git commit -am "chore: 1.2.3"
   git tag -s v1.2.3 -m "v1.2.3"
   git push origin main
   git push origin v1.2.3
   ```

   The tag is what starts everything else: `publish.yml` publishes the three
   packages and creates the GitHub release from CHANGES.md; `docs.yml` then
   publishes the site. Retiring the superseded snapshots is the one step left
   to a human -- see below.

5. Retire the snapshots this release supersedes, by hand:

   ```
   pnpm retire 1.2.3                             # prints the plan
   NPM_TOKEN=npm_... pnpm retire 1.2.3 --yes     # carries it out
   ```

   Deprecates every `1.2.3-dev.*`, moves the `dev` dist-tag onto the release,
   and deletes the tags. See "Retiring pre-releases" below.

## Publishing to npm

Pushing a final tag also runs
[`.github/workflows/publish.yml`](https://github.com/lorem-dev/ailoud/blob/main/.github/workflows/publish.yml),
which publishes `@ailoud/core`, `@ailoud/providers` and `ailoud` in that order.

No npm token is involved. The workflow uses npm's trusted publishing: GitHub
mints a short-lived OIDC token for the run, npm exchanges it for a credential
good for minutes, and provenance is attached automatically. Nothing long-lived
is stored, so there is no 90-day expiry to renew.

Except once, per package: a trusted publisher cannot be attached to a package
that does not exist yet, so the first version of each goes out on a token in
the `NPM_TOKEN` secret. The workflow uses the secret when present and OIDC when
not, so deleting the secret is the whole of the switch.

It will not let that drift: a **pre-release** published on the token logs a
warning, and a **final release** with the secret still set fails before
publishing anything. Attaching the publisher (organization `lorem-dev`,
repository `ailoud`, workflow `publish.yml`, environment empty) on all three
package pages and deleting the secret clears it.

One-time setup on npmjs.com, per package -- Package, then Settings, then
Trusted publisher, then GitHub Actions:

| Field                | Value         |
| -------------------- | ------------- |
| Organization or user | `lorem-dev`   |
| Repository           | `ailoud`      |
| Workflow filename    | `publish.yml` |
| Environment          | leave empty   |

The workflow packs with `pnpm` and publishes with `npm`, because each tool has
half of what is needed: `pnpm pack` rewrites the `workspace:*` dependencies
into real versions, which npm requires and will not do itself, and
`npm publish` is the one with OIDC and provenance.

Before publishing, and before anything is built, it refuses a release that
should not happen: a changelog unfit to release, an open high or critical code
scanning alert, a manifest that disagrees with the tag, or the `NPM_TOKEN`
secret still set on a final tag. Then it runs the whole gate.

A code scanning finding blocks only while it is open. One that has been
reviewed is dismissed with its reason and does not block.

## Retiring pre-releases

After a final release, retire the snapshots it supersedes:

```
pnpm retire 1.0.0                             # prints the plan
NPM_TOKEN=npm_... pnpm retire 1.0.0 --yes     # carries it out
```

Run it after every final release. Nothing prompts for it, and until it runs
`npm install ailoud@dev` hands out an older build than `npm install ailoud`.
`NPM_TOKEN` is a granular access token with read-and-write on the three
packages; without it npm asks for a 2FA code on each of the twelve writes.

Deprecating, not unpublishing: a deprecated version keeps every pinned install
working and prints a notice on the next one. It also drops the `dev` dist-tag,
and deletes the tags -- but only those whose commit is reachable from `main`,
because the published provenance attests that commit. The rest are reported and
left in place.

This is a manual step, run under `npm login`: trusted publishing authenticates
`npm publish` and nothing else, so the token it returns cannot deprecate.

If the npm side does not complete, the script leaves the tags alone and exits
non-zero. The tags are what name which pre-releases to retire, so deleting them
after a failed deprecation would destroy the only record of what was missed.

## What a tag triggers

Pushing a tag runs `publish.yml`. When it succeeds,
[`.github/workflows/docs.yml`](https://github.com/lorem-dev/ailoud/blob/main/.github/workflows/docs.yml)
runs on its completion and publishes the documentation for that version to the
`gh-pages` branch with [mike](https://github.com/jimporter/mike), moving the
`latest` alias that the site root redirects to. `publish.yml` also creates the
GitHub release, with the body taken from the `## Version <version>` section of
CHANGES.md by `scripts/release-notes.mjs`.

Nothing else publishes documentation. A push to a branch publishes nothing, so
what is online always describes a version someone can install.

A pre-release publishes nothing either. It reaches docs.yml -- `publish.yml`
runs for pre-releases too -- and the job stops once it reads the version from
the published commit's manifest and finds a `-` in it.

## One-time repository setup

Settings -> Pages -> Source: **Deploy from a branch**, branch `gh-pages`,
folder `/ (root)`.
