<h1 align="center">AILoud</h1>

<p align="center">
  <a href="https://lorem-dev.github.io/ailoud/"><img src="https://img.shields.io/badge/docs-online-blue" alt="Documentation"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/lorem-dev/ailoud" alt="License"></a>
  <a href="https://github.com/lorem-dev/ailoud/actions/workflows/ci.yml"><img src="https://img.shields.io/badge/coverage-90%25-brightgreen" alt="Coverage"></a>
  <a href="https://github.com/lorem-dev/ailoud/actions/workflows/ci.yml"><img src="https://github.com/lorem-dev/ailoud/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

<p align="center">
AILoud transcribes audio and video into a local library, then searches and
summarises it. Speech-to-text runs on your machine; summaries can too.
</p>

---

## Overview

One CLI (`ailoud`) over a local library:

- **Transcribe** audio and video with whisper.cpp, including recordings that
  switch between languages, and attribute lines to speakers.
- **Search** the whole library full-text and get back the matching lines with
  timestamps, not whole transcripts.
- **Summarise** one recording or a tagged group into a saved report, shaped by
  a template for the kind of conversation it was.
- **Serve** the library to an AI agent over
  [MCP](https://lorem-dev.github.io/ailoud/latest/mcp/).

Nothing leaves your machine unless you choose a hosted model for summaries.

## Install

> AILoud is not published yet. Build from source; the published install will
> be documented here.

Needs [Node.js](https://nodejs.org/) 24+ and [pnpm](https://pnpm.io/) 11+.

```shell
git clone https://github.com/lorem-dev/ailoud.git
cd ailoud
pnpm install && pnpm build && pnpm link --global
```

Then install the tools it drives -- ffmpeg, whisper.cpp, the models:

```shell
ailoud setup
ailoud doctor
```

See [Getting Started](https://lorem-dev.github.io/ailoud/latest/getting-started/).

---

## CLI quick start

Import, transcribe, read:

```shell
ailoud audio import ~/Recordings --tag standup
ailoud audio transcribe
ailoud audio ls
ailoud audio show 01M1B2
```

Find where something was said, without reading a transcript:

```shell
ailoud audio search rollback
ailoud audio f "before sunrise" --tag standup
```

Summarise, with a shape and the context the transcript does not carry:

```shell
ailoud audio summarize 01M1B2 --template one-on-one \
  --context "Ann is Ben's manager; this is their fortnightly."
ailoud report ls
```

Every verb has a one-letter alias, and the letter means the same in every
group -- `l` list, `v` view, `r` remove, `f` find:

```shell
ailoud audio l
ailoud report l
```

Run `ailoud --help` or `<command> --help` for the full set, also in the
[CLI Reference](https://lorem-dev.github.io/ailoud/latest/usage/cli/).

---

## Templates

A template decides a summary's headings, because different conversations
divide differently: `one-on-one`, `performance-review`,
`architecture-planning`, `solution-decision`, `offsite`, `meeting`.

```shell
ailoud template ls
ailoud template new sprint-retro --from one-on-one
```

They are YAML files in `~/.config/ailoud/templates/`. Edit one and the change
takes effect; AILoud never overwrites a file you have edited. See
[Templates](https://lorem-dev.github.io/ailoud/latest/usage/templates/).

---

## MCP

```json
{ "mcpServers": { "ailoud": { "command": "ailoud", "args": ["mcp"] } } }
```

Sixteen tools over the same library the CLI uses. Deleting takes two calls: the
first describes what would go and returns a confirmation token, the second
carries it out. See [MCP](https://lorem-dev.github.io/ailoud/latest/mcp/).

---

## Development

A pnpm workspace: `packages/core` (domain and ports, no I/O),
`packages/providers` (adapters), `apps/cli` (commands and the MCP server).

```shell
pnpm build && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:cov
```

See the
[Development guide](https://lorem-dev.github.io/ailoud/latest/development/development/)
and [Architecture](https://lorem-dev.github.io/ailoud/latest/development/architecture/).
Commit rules and the dependency licence policy are in
[CONTRIBUTING.md](./CONTRIBUTING.md).

---

## License

Apache-2.0. See [LICENSE](./LICENSE).
