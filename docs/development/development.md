# Development

## Setup

```
git clone https://github.com/lorem-dev/ailoud.git
cd ailoud
pnpm install
pnpm build
```

Needs [Node.js](https://nodejs.org/) 24+ and [pnpm](https://pnpm.io/) 11+.

## The gate

Run all of it before calling anything done:

```
pnpm build
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:cov
```

`test:cov` enforces 90% coverage on `packages/core`.

End-to-end, driving the built binary:

```
pnpm test:e2e
```

It asserts the working tree stays clean, so commit before running it.

## While working

```
pnpm test              # all unit tests
pnpm vitest run <path> # one file
pnpm format            # fix formatting
```

## Conventions

- TypeScript, NodeNext modules, `.js` extensions on relative imports.
- `verbatimModuleSyntax` and `noUncheckedIndexedAccess` are on.
- Source and documentation are ASCII-only. An escape byte is written as the
  four-character sequence `\u001b`, never as a literal control character.
- Tests use [vitest](https://vitest.dev/). The e2e suite uses Jest.
- No `eval`, no `Function()`, no dynamic `import()` of a user-supplied path.
- Every subprocess is spawned with an argument array, never a shell string,
  and always with a timeout.

## Documentation

This site is [mkdocs](https://www.mkdocs.org/) with the
[Material](https://squidfunk.github.io/mkdocs-material/) theme. Python tooling
is driven by [uv](https://docs.astral.sh/uv/), never pip:

```
uv run --with-requirements docs/requirements.txt mkdocs serve
uv run --with-requirements docs/requirements.txt mkdocs build --strict
```

The strict build runs in CI on every push, so a broken link fails there rather
than at a release tag.

Writing rules: examples over prose, short sentences, plenty of links, simple
English only. See
[AGENTS.md](https://github.com/lorem-dev/ailoud/blob/main/AGENTS.md).

## Local skills

`.agents/skills/` holds development routines. Notable ones:

| Skill                   | When                                                   |
| ----------------------- | ------------------------------------------------------ |
| `run-tests-and-linters` | before marking any task done                           |
| `check-licenses`        | after editing any `package.json`                       |
| `check-changes`         | after a batch of commits                               |
| `check-docs`            | after changing commands or options                     |
| `check-fixtures`        | after touching import, transcribe or the STT providers |
| `pre-release-check`     | before cutting a release                               |

## Contributing

Commit rules, the dependency licence policy and GPG signing are in
[CONTRIBUTING.md](https://github.com/lorem-dev/ailoud/blob/main/CONTRIBUTING.md).
