---
name: bump-version
description: >
  Set the ailoud version across every package.json and promote the CHANGES.md
  Development section to a released Version section, then create the release
  commit. Does not tag or push.
---

# bump-version

Bump the ailoud version and prepare the release commit. Tagging and pushing
remain separate, deliberate steps.

## Steps

### 1. Require a clean working tree

Run `git status --short`. If there is any output, stop and ask the developer
to commit or stash first. The bump must be reviewable as an isolated diff.
`scripts/bump-version.mjs` checks this itself and exits non-zero if the tree
is dirty, but confirm it here too so the failure is diagnosed before the
script runs.

### 2. Run the bump script

Run `node scripts/bump-version.mjs <version>` with the target version (for
example `0.1.0-rc.1`). The script:

- writes `<version>` into the root, `packages/core`, `packages/providers`,
  and `apps/cli` manifests, and
- promotes `## Development` in `CHANGES.md` to `## Version <version>`,
  leaving a fresh empty `## Development` block above it.

If the script exits non-zero (dirty tree, missing version argument, or a
version that does not parse as semver), report the error and stop.

### 3. Review the diff

Run `git diff` and confirm the version bump touched exactly these files:

- the 4 `package.json` files (root, `packages/core`, `packages/providers`,
  `apps/cli`), and
- `CHANGES.md` (the promoted `## Version <v>` section plus a fresh empty
  `## Development`).

No other files changed. There is no `Cargo.toml` and no
`tauri.conf.json` in this project -- ailoud is a pure TypeScript workspace.

### 4. Create the release commit

```bash
git add -A
git commit -m "chore: release <version>"
```

`release` is not one of the Conventional Commits types this project allows
(`feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `perf`, `ci`, `build`),
so the release commit uses `chore:`, not a bare `release:` prefix.

Do NOT create a tag or push. Cutting the tag is a separate, explicit step
performed only after the release gate passes.

Which branch the eventual tag belongs on depends on the version you just set:

- A **release candidate** (`<version>-rc.<n>`) is tagged on **`develop`**.
- A **final release** (no pre-release suffix) is tagged on **`main`**, after
  `develop` merges there.

Only release-candidate tags may come from `develop`; a final tag pushed from
`develop` is expected to fail. See [AGENTS.md](../../../AGENTS.md) and
[CONTRIBUTING.md](../../../CONTRIBUTING.md) for the branching and tagging
rules in full.
