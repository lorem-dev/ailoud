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

Except once, per package. A trusted publisher is attached to a package on
npmjs.com, and there is no page to attach it to until the package exists, so
the first version of each has to go out on a token in the `NPM_TOKEN` secret --
npm answers `ENEEDAUTH` without one however complete the OIDC setup is. The
workflow uses the secret when it is present and OIDC when it is not, so
deleting the secret is the whole of the switch.

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
node scripts/retire-prereleases.mjs 1.0.0          # prints the plan
node scripts/retire-prereleases.mjs 1.0.0 --yes    # carries it out
```

Deprecating, not unpublishing: a deprecated version keeps every pinned install
working and prints a notice on the next one. It also drops the `dev` dist-tag,
and deletes the tags -- but only those whose commit is reachable from `main`,
because the published provenance attests that commit. The rest are reported and
left in place.

`publish.yml` runs this itself after a final release, through
`retire.yml`. That is the only way it runs in CI: npm binds a trusted publisher
to a workflow file, so a run entered through `retire.yml` is a different
identity and the exchange is refused.

No token is involved here either. Trusted publishing covers publishing, so
`npm deprecate` has nothing to authenticate with; the script performs the same
exchange `npm publish` does for itself -- a GitHub id token with audience
`npm:registry.npmjs.org`, posted to
`/-/npm/v1/oidc/token/exchange/package/<name>` -- and uses the short-lived
token it returns.

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
