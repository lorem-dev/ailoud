<h1 align="center">AILoud</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/ailoud"><img src="https://img.shields.io/npm/v/ailoud" alt="npm"></a>
  <a href="https://lorem-dev.github.io/ailoud/"><img src="https://img.shields.io/badge/docs-online-blue" alt="Documentation"></a>
  <a href="https://github.com/lorem-dev/ailoud/blob/main/LICENSE"><img src="https://img.shields.io/github/license/lorem-dev/ailoud" alt="License"></a>
  <a href="https://github.com/lorem-dev/ailoud/actions/workflows/ci.yml"><img src="https://img.shields.io/badge/coverage-90%25-brightgreen" alt="Coverage"></a>
  <a href="https://github.com/lorem-dev/ailoud/actions/workflows/ci.yml"><img src="https://github.com/lorem-dev/ailoud/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

<p align="center">
AILoud transcribes audio and video into a local library, then searches and
summarises it. Speech-to-text runs on your machine; summaries can too.
</p>

---

## Install

Needs [Node.js](https://nodejs.org/) 24 or newer.

```shell
npm install -g ailoud
```

`setup` installs the tools it drives -- ffmpeg, whisper.cpp, the models --
and `doctor` checks them:

```shell
ailoud setup
ailoud doctor
```

Nothing leaves your machine unless you choose a hosted model for summaries.

## Update

```shell
ailoud self update
```

It checks the registry first, so there is nothing to run before it. A snapshot
moves only to a newer snapshot of the same version, or to a release.

---

## Use it with an agent

```shell
ailoud mcp install
```

It configures one or more agents, at project or global scope:

| Agent      | Scopes          |
| ---------- | --------------- |
| `claude`   | project, global |
| `codex`    | project, global |
| `opencode` | project, global |
| `gemini`   | project, global |
| `hermes`   | global only     |
| `copilot`  | global only     |

It writes the MCP registration and a rules block the agent reads before its
first call. The agent then gets these tools:

```shell
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | ailoud mcp | jq -r '.result.tools[].name'
```

```
list_recordings
list_untagged
list_tags
search_transcripts
get_transcript
list_speakers
list_reports
get_report
list_templates
annotate
import_recording
transcribe
summarize
create_template
delete_recording
delete_report
```

Reading tools return matches and file paths, never a whole transcript in one
call; deleting needs a second call carrying a confirmation token. See
[MCP](https://lorem-dev.github.io/ailoud/latest/mcp/).

---

## The CLI

| Command                                                    | Does                                      |
| ---------------------------------------------------------- | ----------------------------------------- |
| `audio import\|transcribe\|annotate\|search\|ls\|show\|rm` | the library and everything over it        |
| `audio summarize`                                          | writes a summary and saves it as a report |
| `report ls\|show\|rm`                                      | saved reports                             |
| `template ls\|new`                                         | what shape a summary of a kind takes      |
| `mcp` and `mcp install\|uninstall\|update`                 | serve the library to an agent             |
| `doctor`, `setup`                                          | check and provision the machine           |
| `self check\|update\|sync`                                 | this installation of ailoud               |

Every verb also works at the top level, and has a one-letter alias. Full
reference: [CLI Reference](https://lorem-dev.github.io/ailoud/latest/usage/cli/).

---

## Documentation

- [Getting Started](https://lorem-dev.github.io/ailoud/latest/getting-started/)
- [Usage](https://lorem-dev.github.io/ailoud/latest/usage/recordings/)
- [MCP](https://lorem-dev.github.io/ailoud/latest/mcp/)
- [Development](https://lorem-dev.github.io/ailoud/latest/development/development/)

---

## Development

A pnpm workspace: `packages/core` (domain and ports, no I/O),
`packages/providers` (adapters), `apps/cli` (commands and the MCP server).

```shell
pnpm build && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:cov
```

Commit rules and the dependency licence policy are in
[CONTRIBUTING.md](https://github.com/lorem-dev/ailoud/blob/main/CONTRIBUTING.md).

---

## License

Apache-2.0. See [LICENSE](https://github.com/lorem-dev/ailoud/blob/main/LICENSE).
