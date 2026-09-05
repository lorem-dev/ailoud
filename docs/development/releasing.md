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
   documentation, changelog and version checks.
2. Run the `bump-version` skill. It sets the version across every
   `package.json`, promotes the CHANGES.md Development section, and makes the
   release commit. It does not tag or push.
3. Extract the release body:

   ```
   node scripts/release-notes.mjs v1.2.3
   ```

   It reads the `## Version 1.2.3` section and writes `RELEASE_NOTES.md`. It
   exits non-zero if that section is missing, empty, or over the hard limit.

4. Merge to `main` and tag:

   ```
   git tag -s v1.2.3 -m "v1.2.3"
   git push origin main --tags
   ```

## Publishing to npm

Pushing a final tag also runs
[`.github/workflows/publish.yml`](https://github.com/lorem-dev/ailoud/blob/main/.github/workflows/publish.yml),
which publishes `@ailoud/core`, `@ailoud/providers` and `ailoud` in that order.

No npm token is involved. The workflow uses npm's trusted publishing: GitHub
mints a short-lived OIDC token for the run, npm exchanges it for a credential
good for minutes, and provenance is attached automatically. Nothing long-lived
is stored, so there is no 90-day expiry to renew.

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

Before publishing it checks that all three manifests agree with the tag, that
the changelog is fit to release, and then runs the whole gate.

## Retiring pre-releases

After a final release, retire the snapshots it supersedes:

```
node scripts/retire-prereleases.mjs 1.0.0          # prints the plan
node scripts/retire-prereleases.mjs 1.0.0 --yes    # carries it out
```

Deprecating, not unpublishing: a deprecated version keeps every pinned install
working and prints a notice on the next one. It also drops the `dev` dist-tag,
and deletes the tags -- but only those whose commit is reachable from `main`,
because the published provenance attests that commit. The rest are reported and
left in place.

It is a manual step, not part of `publish.yml`: trusted publishing issues a
credential for publishing, and a release is the wrong moment to find out what
else it covers.

## What a tag triggers

Pushing a final tag runs
[`.github/workflows/docs.yml`](https://github.com/lorem-dev/ailoud/blob/main/.github/workflows/docs.yml),
which publishes the documentation for that version to the `gh-pages` branch
with [mike](https://github.com/jimporter/mike) and moves the `latest` alias
that the site root redirects to.

Nothing else publishes documentation. A push to a branch publishes nothing, so
what is online always describes a version someone can install.

A pre-release tag (`v1.2.3-rc.1`, or any tag with a `-` qualifier) publishes
nothing either. The workflow refuses it twice: the tag filter never starts it,
and the job checks again in case `workflow_dispatch` was pointed at one.

## One-time repository setup

Settings -> Pages -> Source: **Deploy from a branch**, branch `gh-pages`,
folder `/ (root)`.
