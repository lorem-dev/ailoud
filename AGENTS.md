# AGENTS.md -- ailoud

This file is addressed to AI coding agents. Read it fully before touching code.

**Must read:** [CONTRIBUTING.md](./CONTRIBUTING.md)

---

## Project Overview

`ailoud` is a command-line tool that turns audio and video files into
transcripts, keeps those transcripts in a local library, and answers
questions over one or many of them through a large language model. It has
two strictly separate engine layers: speech-to-text (local whisper.cpp or a
cloud API) turns audio into timestamped segments, and an LLM (Anthropic, an
OpenAI-compatible endpoint, or an agent CLI) summarizes and reasons over the
resulting text. No microphone or system-audio capture; import only. The CLI
is the only front end -- there is no GUI, and the interface is English-only.
The multilingual part of this project is the audio, not the UI.

M1, the current milestone, ships `import`, `transcribe`, `ls`, `show`, and
`doctor`. The rest of the CLI surface (`search`, `collection`, `tag`,
`summarize`, `export`, `config`) belongs to later milestones and does not
exist yet; do not document or assume commands beyond what M1 lists. The full
design lives in the maintainer's planning notes under `.superpowers/`, which
is not tracked in git, so treat this file as the authority on what exists.

---

## Workspace Layout

A pnpm workspace of three packages, plus a fixture audio directory and the
end-to-end suite:

```
ailoud/
  packages/
    core/         domain model, ports, db schema and migrations, pipelines,
                  transcript formatters (text, srt, vtt)
    providers/    port implementations: audio (ffmpeg), store (sqlite),
                  stt (whisper.cpp), system (fs, clock)
  apps/
    cli/          commander command tree, binary `ailoud`
  e2e/            Jest end-to-end suite, driving the built binary
  fixtures/       short audio samples with reference transcripts
  .agents/skills/ local development skills
  .github/workflows/
```

`e2e/` and `fixtures/` exist. The e2e suite is split by what a spec needs from
the machine: the `no-tools` project (`pnpm test:e2e:no-tools`) drives the
binary without ffmpeg, whisper or a model and runs in CI on every push and
pull request; the `tools` project needs a provisioned machine and runs in CI on
pushes only, after `ailoud setup`. See "Running the Gate" below.

### Dependency direction

```
apps/cli  ->  packages/providers  ->  packages/core
apps/cli  ->  packages/core
```

`packages/core` imports nothing from the rest of the workspace and performs
no I/O: no `node:fs`, no `node:child_process`, no `node:sqlite`, no network.
Everything it needs arrives as a constructor argument (see the `Clock`,
`Ids`, and `Fs` ports in the design doc), which is what makes the pipelines
testable in memory. `eslint-plugin-boundaries` enforces this matrix in
`eslint.config.mjs` with `default: disallow`, so a new package is denied
until the matrix names it.

---

## Running the Gate

Prerequisites: Node 24+ and pnpm via `corepack enable`.

```bash
corepack enable
pnpm install

pnpm build         # tsc -b, project references (must run first: cross-package types resolve through dist)
pnpm format:check  # Prettier, no writes
pnpm lint          # ESLint
pnpm typecheck     # tsc --noEmit, per package
pnpm test:cov      # Vitest with v8 coverage; fails below 90% (packages/core)
```

All of these must pass before a pull request is ready. Run the full gate as a
single step at the end of a change, not after every task; while iterating,
run only the focused test or typecheck for what you changed.

Two commands exist for driving the CLI while working on it. `pnpm ailoud <args>`
builds and runs in one step, forwarding its arguments; `pnpm watch` leaves
`tsc -b` rebuilding on save. Both rely on the same incremental build as the
gate, so neither recompiles a package whose inputs have not changed. The
build progress line goes to stderr, so `pnpm ailoud ls --json` still pipes.

`pnpm test:e2e` (Jest, the built binary against `fixtures/`) is not part of
this gate and is not wired into CI: it needs a real `ffmpeg`, a whisper.cpp
binary, and a model file. On a machine missing any of those, the specs that
need them fail loudly, naming the missing piece; that is expected and not a
regression. See `check-fixtures` for how to read those failures.

---

## Conventions

### TypeScript

- Module system: `NodeNext`. All relative imports in source files must end
  with `.js` (the compiled extension), not `.ts`.
- `isolatedModules` and `verbatimModuleSyntax` are on. Mark every type-only
  export and import with `export type` / `import type`.
- The toolchain runs at the maximum practical strictness, configured once in
  `tsconfig.base.json` and inherited by every package. On top of `strict`:
  `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`,
  `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`,
  `noPropertyAccessFromIndexSignature`, `allowUnreachableCode: false`, and
  `allowUnusedLabels: false`. Treat `pnpm typecheck` as a hard gate: fix the
  code, never loosen a flag to make an error go away.
- `exactOptionalPropertyTypes` is deliberately left off. Do not enable it
  without checking what it does to the port and pipeline option shapes.
- No `any` without a comment explaining why it is safe.

### Text and Encoding

All source code and documentation are ASCII-only. No Unicode punctuation
(curly quotes, em dashes, ellipsis characters) anywhere. This project has no
translated interface to carve an exception for -- ailoud is English-only at
the interface, so the rule has no exceptions there.

Two exceptions, both the same shape -- content being transcribed or searched
for, never UI text or code:

- Fixture data: `fixtures/*.txt` reference transcripts hold the actual words a
  fixture's audio says, and `fixtures/ru-short.txt` is necessarily Cyrillic.
- Documentation examples of non-English material: a search example showing
  `ailoud audio f "гаван*"`, or a summary shown in the language of its
  recording. AILoud exists for recordings that are not in English, and
  demonstrating prefix search on an inflected language in English defeats the
  demonstration. Prose around the example stays ASCII.

### Commit Rules

Follow [CONTRIBUTING.md](./CONTRIBUTING.md) exactly:

- Conventional Commits types: `feat`, `fix`, `chore`, `docs`, `test`,
  `refactor`, `perf`, `ci`, `build`.
- English, imperative mood, subject under 72 characters.
- No AI-tool mentions anywhere in commit messages or trailers.
- Scopes only when already established in `git log`.

### Branching

`feature/*` -> `develop` -> `main` via pull request. Direct commits to `main`
are allowed only until the first release.

Tagging follows the same split:

- **Release-candidate tags** (`v<version>-rc.<n>`) are cut from **`develop`**.
- **Final release tags** (`v<version>`, no pre-release suffix) are cut from
  **`main`**, after `develop` has merged there.

Only RC tags may come from `develop`. This is a convention, not something a
workflow enforces today: no CI job checks tag provenance, so follow it by
hand (see `pre-release-check`'s branch verification step) until one exists.

---

## Specs and Plans

Design specs, implementation plans, and task-level artifacts (briefs,
reports, progress notes) all live under `.superpowers/` and are git-ignored,
matching the `skillkeeper` repository this project inherits its conventions
from. They are working notes for driving an implementation, not a published
record.

The consequence is that a fresh clone carries no design document. Anything a
contributor must know to work here belongs in this file, in README.md, or in
CONTRIBUTING.md -- not in a plan only the maintainer has.

---

## Agent Installation

`ailoud mcp install` registers AILoud with an agent and writes the rules block
it reads. Both halves matter: an agent with the tools and no guidance reads
whole transcripts into its context.

- The block is delimited by `<!-- AILOUD_START -->` and `<!-- AILOUD_END -->`.
  Everything outside the markers belongs to the user and is never touched.
  Install, update and uninstall all find the markers and act only between them.
- Adding is idempotent: installing twice produces the same bytes as once, which
  is what makes `update` safe to run after every upgrade.
- Every agent path and file format in `apps/cli/src/mcp/agents.ts` was read from
  a working installation, never guessed. A wrong path writes a file nothing
  reads, which looks exactly like a successful install.
- `uninstall` deletes a config file AILoud created and _edits_ one that holds
  anything else. It never deletes the `.ailoud/` library: unregistering an
  agent is not a request to destroy recordings.
- Agents that read no per-project configuration (Hermes, Copilot CLI) are
  marked global-only in the table, and the scope question is skipped when every
  chosen agent is one of them.

A project keeps its own library in `.ailoud/`, found by walking up from the
working directory the way git finds `.git`. The config stays per-user: it names
installed binaries and model files, and making it local would mean
re-downloading a 488 MB model per repository.

---

## Documentation

The site lives in `docs/` and builds with mkdocs + the Material theme. It is
published per release to the `gh-pages` branch by
`.github/workflows/docs.yml`; `ci.yml` runs the strict build on every push.

```
uv run --with-requirements docs/requirements.txt mkdocs serve
uv run --with-requirements docs/requirements.txt mkdocs build --strict
```

Python tooling here is driven by `uv`, never `pip` or a hand-rolled venv.

### Structure

Four sections, and new pages belong in one of them:

| Section         | Holds                                            |
| --------------- | ------------------------------------------------ |
| Getting Started | install, set up, first transcript, first summary |
| Usage           | one page per thing you do with the CLI           |
| MCP             | configuring and using the MCP server             |
| Development     | architecture, the gate, releasing                |

Every page added to `docs/` must appear in `nav:` in `mkdocs.yml`, or the
strict build fails.

### Writing rules

- **Examples over prose.** Lead with a command block. Explain after, if at
  all. A page that is mostly paragraphs is a page nobody reads.
- **Short text.** One or two sentences between examples. Cut a sentence that
  restates what the example already shows.
- **Tables over paragraphs** for options, flags, states and comparisons.
- **Link generously** -- to other pages, to the CLI reference, to upstream
  projects. Prefer a link to re-explaining something.
- **Simple English, and English only.** Short words, short sentences, active
  voice. No idioms and no jokes: many readers are not native speakers. The
  exception is example content in another language (see "Text and Encoding").
- **Show real output** where it helps, copied from an actual run rather than
  invented. Invented output goes stale silently and is wrong immediately.
- **No changelogs and no rationale essays.** Reasoning belongs in code
  comments, commit messages and CHANGES.md, not in the user-facing docs.

Run the `check-docs` skill after changing any command or option.

---

## Branches and Tags

| Branch    | Is                                      |
| --------- | --------------------------------------- |
| `main`    | the release branch                      |
| `develop` | integration; feature branches land here |

**While the project is pre-release, work happens directly on `main`** and
`develop` follows it: a push to `main` opens a back-merge PR
(`.github/workflows/backmerge.yml`). Once releases start that inverts --
features land on `develop`, only release commits reach `main` -- and the same
workflow keeps `develop` from falling behind either way. Both branches are
protected against deletion and force-push with CI required; an admin can still
push directly, which is what makes the pre-release flow possible.

The three required checks are the ones that run on a pull request. The
provisioned end-to-end job is deliberately NOT required: it runs only on push,
so requiring it would leave every PR waiting for a check that never arrives.

| Tag            | Cut from   | npm dist-tag | Docs |
| -------------- | ---------- | ------------ | ---- |
| `v1.2.3-dev.1` | any branch | `dev`        | no   |
| `v1.2.3-rc.1`  | `develop`  | `next`       | no   |
| `v1.2.3`       | `main`     | `latest`     | yes  |

Only a final tag moves `latest` and publishes the site, so `npm install ailoud`
never picks up a pre-release and the site never describes a version nobody can
install. `publish.yml` refuses a tag that disagrees with any manifest version.

One exception, and it cannot be worked around: npm sets `latest` on a package's
FIRST publish whatever `--tag` says, and `latest` can be moved but never
removed. A package whose first release was a pre-release therefore answers
`npm install <name>` with it until a final version exists.

Use the `dev-tag` skill for a snapshot; `bump-version` then `pre-release-check`
for a release.

Publishing is by trusted publishing (OIDC), with no stored credential. The one
exception is a package's first version: a trusted publisher is attached to a
package that already exists, so a token in the `NPM_TOKEN` secret has to
introduce each package to the registry. `publish.yml` uses the secret when it
is there and OIDC when it is not, warns on a pre-release published with the
token, and REFUSES a final release while the secret is still set.

Cutting a final tag folds its pre-release sections back into one:

```
node scripts/fold-prereleases.mjs 1.0.0   # merges 1.0.0-dev.* and Development
node scripts/check-changelog.mjs v1.0.0   # refuses if anything is left over
```

Once the final release is published, retire the pre-releases it supersedes:

```
node scripts/retire-prereleases.mjs 1.0.0          # prints the plan
node scripts/retire-prereleases.mjs 1.0.0 --yes    # carries it out
```

That deprecates each `1.0.0-dev.*` version on npm, drops the `dev` dist-tag,
and deletes the tags. Three things it deliberately does not do:

- **Unpublish.** npm allows it for 72 hours, the version number can never be
  reused after, and anyone who pinned the version has their install broken.
  A deprecated version keeps working and prints a notice.
- **Delete a tag whose commit is not on `origin/main`.** The published
  provenance attests that commit; unreachable, it can be collected, leaving
  the attestation pointing at nothing. Those tags are reported and kept.
- **Run in CI.** Trusted publishing issues a token for `npm publish`; whether
  it can deprecate is not something to discover halfway through a release.

`publish.yml` runs the check on every tag before it builds anything. The limits
live in `scripts/lib/changelog.mjs` and are quoted, not restated, everywhere
else -- a limit that differs between the script that warns and the script that
refuses is worse than no limit. The scripts have tests
(`scripts/**/*.test.mjs`), which run in CI on branches and pull requests but
not on tags.

---

## The Changelog

`CHANGES.md` is for someone deciding whether to upgrade. It is not a commit
log: how the code got this way belongs in commit messages and code comments,
which survive and are searchable.

### Limits

Counted per version section, across all its subsections:

| Limit | Count | Means                                                   |
| ----- | ----- | ------------------------------------------------------- |
| soft  | 10    | aim for this; over it, look for entries to merge or cut |
| hard  | 50    | a release must not ship with more                       |

`scripts/release-notes.mjs` enforces both at release time -- it warns past the
soft limit and exits non-zero past the hard one, because that is the last point
before the notes reach anyone.

### What goes in

- A feature, option or command a user can now use.
- A change in behaviour they would otherwise be surprised by.
- A fix for something that was **broken in a released version**.
- A removal, or anything needing action on upgrade.

### What stays out

- Anything fixed before it ever shipped. If no released version had the bug,
  the changelog has nothing to say about it. Before the first release, that is
  every fix -- and the reason this file is 14 entries rather than 158.
- Refactoring, test changes, CI, internal renames, dependency bumps with no
  user-visible effect.
- The reasoning behind a change. One clause of why is fine where it changes
  what a reader does; an essay is not.

### Form

One entry per user-visible thing, present tense, active voice. Name the command
or option in backticks so it is greppable. Wrap at 80 columns, ASCII only.

Merge before you cut: four entries about one feature usually want to be one
entry that names the feature.

### Sections

`## Development` collects unreleased entries. `bump-version` promotes it to
`## Version <v>`, and `release-notes.mjs` extracts that section into
`RELEASE_NOTES.md` for the GitHub release body:

```
node scripts/release-notes.mjs v1.2.3
```

That heading format is a contract between the two scripts and the file. The
same rules are repeated as a comment at the top of `CHANGES.md`, where someone
about to add an entry will actually see them.

---

## Local Development Skills

Seven skills live under `.agents/skills/`. Invoke them when the situation
calls for it:

| Skill                   | When to use                                                                                                                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bump-version`          | To start a release -- set the version across every `package.json` and promote the CHANGES.md Development section, then make the release commit. Does not tag or push.                                                            |
| `check-changes`         | After a batch of commits -- verify CHANGES.md (Development section) reflects every user-visible change, and stays inside the limits above.                                                                                       |
| `check-docs`            | Before a release or after updating commands/options -- verify README.md and AGENTS.md are current.                                                                                                                               |
| `check-licenses`        | After editing any `package.json` -- verify all npm dependencies are license-compliant and update LICENSE.                                                                                                                        |
| `run-tests-and-linters` | Before marking any task done -- run the full gate (build, format check, lint, typecheck, test:cov at 90%).                                                                                                                       |
| `check-fixtures`        | After touching import, transcribe, or the audio/STT providers -- drive the built binary against `fixtures/` end to end, in a throwaway `HOME`, `XDG_CONFIG_HOME`, and `XDG_DATA_HOME`, and confirm the working tree stays clean. |
| `pre-release-check`     | Before cutting a release -- runs the `check-*` and `run-tests-and-linters` skills above (not `bump-version`) plus version-bump and commit-format checks.                                                                         |
| `dev-tag`               | To publish a snapshot to npm under the `dev` dist-tag without promising a release -- cuts a `v<version>-dev.<n>` tag.                                                                                                            |

---

## Security Notes

- Every subprocess (`ffmpeg`, the whisper binary, an agent CLI) is spawned
  with an argument array, never a shell string. This matters more here than
  in most tools because file paths in `ailoud` come from user input.
- Every subprocess call carries a timeout.
- Secrets (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or a Locksmith-backed
  alias) are read from the environment or from Locksmith. They never reach
  `config.yaml` or a log, and `doctor` reports only whether a credential is
  present, never its value.
- Do not introduce `eval`, `Function()`, or dynamic `import()` of a
  user-supplied path.

<!-- CODEGRAPH_START -->

## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call -- the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely -- indexing is the user's decision.
<!-- CODEGRAPH_END -->
