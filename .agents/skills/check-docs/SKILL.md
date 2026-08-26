---
name: check-docs
description: >
  Verify that README.md, AGENTS.md and CONTRIBUTING.md are current with the
  code: documented commands and options still exist, cross-references
  resolve, and version references match the current version in package.json.
---

# check-docs

Verify that all project documentation is accurate and up to date. Before a
release, or right after adding or changing a CLI command or option.

## Steps

1. **Read the current version.**
   Open the root `package.json` and note the `version` field. It must match
   the `version` field in `packages/core/package.json`,
   `packages/providers/package.json`, and `apps/cli/package.json`.

2. **Check README.md.**
   - Confirm every `pnpm` command shown in README.md exists as a script in
     the root `package.json` (`pnpm lint`, `pnpm typecheck`, `pnpm test:cov`,
     `pnpm build`, `pnpm format:check`, `pnpm test:e2e`, etc.).
   - Confirm every `laud` CLI command shown (`import`, `transcribe`, `ls`,
     `show`, `doctor`) is a command M1 actually ships, per the "Project
     Overview" section of AGENTS.md. `laud` has no `search`, `collection`,
     `tag`, `summarize`, `export`, or `config` command yet; flag any of
     those names if they appear in README.md or AGENTS.md.
   - Confirm every relative link in README.md and AGENTS.md resolves to a
     file that exists in the repository. Links into `.superpowers/` are a
     defect: that directory is git-ignored and absent from a fresh clone.

3. **Check the documented layout for drift.**
   Confirm the workspace layout and dependency direction described in
   AGENTS.md still match `pnpm-workspace.yaml` and the `packages/` and
   `apps/` directories on disk. If a design spec is present under
   `.superpowers/`, cross-check it too, but do not require it -- it is
   git-ignored and will be missing on most checkouts.

4. **Check documented CLI commands against the source.**
   For each command documented in README.md or AGENTS.md, verify the
   corresponding commander command still exists under `apps/cli/src/`.

5. **Check version references.**
   Search `README.md`, `AGENTS.md` and `CONTRIBUTING.md` for version
   strings. Any hardcoded version must match the version in root
   `package.json`. This project ships no documentation site.

6. **Check CHANGES.md structure.**
   Confirm the file starts with a `## Development` section and that
   previous release sections follow the `## Version X.Y.Z` heading format
   (no date).

7. **Report.**
   List every issue found (broken cross-references, stale commands,
   version mismatches, mentions of a command that does not exist yet). If
   everything is current, report "Docs are current." Do not edit
   documentation automatically -- propose corrections and let the
   developer apply them.
