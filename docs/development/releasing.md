# Releasing

## Branches

| Branch           | Is                                      |
| ---------------- | --------------------------------------- |
| `main`           | the release branch                      |
| `develop`        | integration; feature branches land here |
| `feature/<name>` | feature work, branched from `develop`   |

## Tags

| Tag                 | Means                                    |
| ------------------- | ---------------------------------------- |
| `v<version>-rc.<n>` | a release candidate, tagged on `develop` |
| `v<version>`        | a final release, tagged on `main` only   |

## Steps

1. Run the `pre-release-check` skill. It runs the whole gate plus the
   documentation, changelog and version checks.
2. Run the `bump-version` skill. It sets the version across every
   `package.json`, promotes the CHANGES.md Development section, and makes the
   release commit. It does not tag or push.
3. Merge to `main` and tag:

   ```
   git tag -s v1.2.3 -m "v1.2.3"
   git push origin main --tags
   ```

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
