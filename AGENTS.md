# AGENTS.md -- laud

This file is addressed to AI coding agents. Read it fully before touching code.

**Must read:** [CONTRIBUTING.md](./CONTRIBUTING.md)

---

## Project Overview

`laud` is a command-line tool that turns audio and video files into
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
laud/
  packages/
    core/         domain model, ports, db schema and migrations, pipelines,
                  transcript formatters (text, srt, vtt)
    providers/    port implementations: audio (ffmpeg), store (sqlite),
                  stt (whisper.cpp), system (fs, clock)
  apps/
    cli/          commander command tree, binary `laud`
  e2e/            Jest end-to-end suite, driving the built binary
  fixtures/       short audio samples with reference transcripts
  .agents/skills/ local development skills
  .github/workflows/
```

`e2e/` and `fixtures/` exist; they are not part of the everyday gate (see
"Running the Gate" below).

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

Two commands exist for driving the CLI while working on it. `pnpm laud <args>`
builds and runs in one step, forwarding its arguments; `pnpm watch` leaves
`tsc -b` rebuilding on save. Both rely on the same incremental build as the
gate, so neither recompiles a package whose inputs have not changed. The
build progress line goes to stderr, so `pnpm laud ls --json` still pipes.

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
translated interface to carve an exception for -- laud is English-only at
the interface, so the rule has no exceptions there.

The one exception is fixture data: `fixtures/*.txt` reference transcripts
hold the actual words a fixture's audio says, and `fixtures/ru-short.txt`
is necessarily Cyrillic. That is data being transcribed, not UI text or
code, so it is exempt.

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

## Local Development Skills

Seven skills live under `.agents/skills/`. Invoke them when the situation
calls for it:

| Skill                   | When to use                                                                                                                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bump-version`          | To start a release -- set the version across every `package.json` and promote the CHANGES.md Development section, then make the release commit. Does not tag or push.                                                            |
| `check-changes`         | After a batch of commits -- verify CHANGES.md (Development section) reflects every change.                                                                                                                                       |
| `check-docs`            | Before a release or after updating commands/options -- verify README.md and AGENTS.md are current.                                                                                                                               |
| `check-licenses`        | After editing any `package.json` -- verify all npm dependencies are license-compliant and update LICENSE.                                                                                                                        |
| `run-tests-and-linters` | Before marking any task done -- run the full gate (build, format check, lint, typecheck, test:cov at 90%).                                                                                                                       |
| `check-fixtures`        | After touching import, transcribe, or the audio/STT providers -- drive the built binary against `fixtures/` end to end, in a throwaway `HOME`, `XDG_CONFIG_HOME`, and `XDG_DATA_HOME`, and confirm the working tree stays clean. |
| `pre-release-check`     | Before cutting a release -- runs the `check-*` and `run-tests-and-linters` skills above (not `bump-version`) plus version-bump and commit-format checks.                                                                         |

---

## Security Notes

- Every subprocess (`ffmpeg`, the whisper binary, an agent CLI) is spawned
  with an argument array, never a shell string. This matters more here than
  in most tools because file paths in `laud` come from user input.
- Every subprocess call carries a timeout.
- Secrets (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or a Locksmith-backed
  alias) are read from the environment or from Locksmith. They never reach
  `config.yaml` or a log, and `doctor` reports only whether a credential is
  present, never its value.
- Do not introduce `eval`, `Function()`, or dynamic `import()` of a
  user-supplied path.
