# MCP

`ailoud mcp` serves your library to an AI agent over
[MCP](https://modelcontextprotocol.io/). The agent can search it, summarise it
and tag it.

## Set it up

The quickest way is to let AILoud do it:

```
ailoud mcp install
```

It asks which agents to configure, with the ones it found on your machine
pre-selected:

```
Which agents should AILoud configure?
  Claude Code (detected)
  Codex CLI (detected)
  opencode (detected)
  Gemini CLI (not found)
  Hermes Agent (not found) -- global only
  GitHub Copilot CLI (detected) -- global only
```

Then where to put it:

```
Where should it be configured?
  This project only    config files in this directory
  Globally             every project on this machine
```

Non-interactively:

```
ailoud mcp install --target claude,codex --location local
ailoud mcp install --target auto --location global --yes
```

It writes two things per agent: the MCP registration, and a rules block in the
agent's instructions file so it uses the tools well. The block is delimited by
`<!-- AILOUD_START -->` and `<!-- AILOUD_END -->`; nothing outside the markers
is touched, and installing twice changes no bytes.

For a per-project install it also creates `.ailoud/`, where that project's
recordings live. See [the project library](#the-project-library).

### Update and remove

```
ailoud mcp update              # refresh the block after upgrading AILoud
ailoud mcp uninstall           # remove the registration and the block
ailoud mcp uninstall --target claude --location local
```

`update` touches only agents that are already configured; it never adds a new
one. `uninstall` deletes a config file AILoud created, edits one that holds
other servers, and leaves `.ailoud/` alone.

Your own files are safe:

- Only the text between the two markers is ever rewritten. A file that merely
  _mentions_ `<!-- AILOUD_START -->` in prose keeps everything around it.
- A `config.toml` that already defines an `ailoud` server some other way is
  refused, not edited. Two definitions of one key is a TOML error, and it would
  break your whole Codex config rather than just this server.
- A Hermes `config.yaml` holding your own settings or comments is rewritten,
  never deleted. Only a file with nothing but AILoud's keys in it is removed.
- A trailing comma or a byte-order mark in a `.jsonc` is tolerated. A file that
  is not JSON at all is refused with a message rather than rewritten.

!!! note

    Comments in a JSON or `.jsonc` MCP config do not survive an edit -- the
    file is parsed and re-serialised. TOML and YAML keep theirs.

### Supported agents

| Agent      | Scopes          | Config                         | Rules file                           |
| ---------- | --------------- | ------------------------------ | ------------------------------------ |
| `claude`   | project, global | `.mcp.json` / `~/.claude.json` | `.claude/CLAUDE.md`, `CLAUDE.md`     |
| `codex`    | project, global | `.codex/config.toml`           | `AGENTS.md`                          |
| `opencode` | project, global | `opencode.jsonc`               | `AGENTS.md`                          |
| `gemini`   | project, global | `.gemini/settings.json`        | `GEMINI.md`                          |
| `hermes`   | global only     | `~/.hermes/config.yaml`        | `~/.hermes/AGENTS.md`                |
| `copilot`  | global only     | `~/.copilot/mcp-config.json`   | `~/.copilot/copilot-instructions.md` |

## Running `ailoud` without an approval prompt

The rules block tells an agent to reach for `ailoud audio search` and its
neighbours. Most agents ask for approval before running a command, every time.
`mcp install` offers to add `ailoud` to the agent's allow-list so it does not
have to.

The prompt appears during an interactive install, after the location question,
and lists the exact files it would edit. `--allow-shell` and `--no-allow-shell`
answer it without a prompt.

`-y` on its own grants nothing. It means "do not prompt", and an unasked
permission question is not the same as one answered yes. Use `-y --allow-shell`
to ask for the allow-list in a script.

| Agent              | File                                                     | Entry                                                       |
| ------------------ | -------------------------------------------------------- | ----------------------------------------------------------- |
| Claude Code        | `.claude/settings.json`, or `~/.claude/settings.json`    | `permissions.allow: ["Bash(ailoud:*)"]`                     |
| Codex CLI          | `~/.codex/policy.yaml`                                   | `allow: ["ailoud", "ailoud *"]`                             |
| opencode           | `opencode.jsonc`, or `~/.config/opencode/opencode.jsonc` | `permission.bash: {"ailoud": "allow", "ailoud *": "allow"}` |
| Gemini CLI         | `.gemini/settings.json`, or `~/.gemini/settings.json`    | `tools.allowed: ["run_shell_command(ailoud)"]`              |
| GitHub Copilot CLI | `~/.copilot/permissions-config.json`                     | a `commands` approval for this directory                    |
| Hermes Agent       | --                                                       | Hermes records approvals itself; nothing to write           |

Codex keeps one policy file for the machine even for a per-project install, and
Copilot scopes its approval to the directory you ran the install in -- which
the install says on its own line, because the file it writes is machine-wide.

!!! note

    The rewrite rule above applies to these files too: comments in
    `.claude/settings.json`, `.gemini/settings.json`, `opencode.jsonc` and
    `~/.copilot/permissions-config.json` do not survive an edit. Codex's
    `policy.yaml` keeps its comments, including any written inside the allow
    list itself.

`mcp uninstall` removes the entry. `mcp update` refreshes one that is already
there and never adds one, which is why `ailoud self sync` cannot widen an
agent's permissions while sweeping your projects.

## The project library

A directory named `.ailoud/` makes that project's recordings separate from
your personal collection. AILoud finds it by walking up from the working
directory, the way git finds `.git`, so it works from any subdirectory.

```
ailoud mcp install --location local   # creates it
ailoud doctor                         # shows which library is in use
```

The directory carries a `.gitignore` that excludes its own contents, so the
database and the media copies never reach git while the directory itself can
be committed.

The config file stays per-user either way. It names installed binaries and
model files, which are not a property of a project.

## By hand

=== "Claude Code / Claude Desktop"

    `.mcp.json` in your project, `~/.claude.json` for every project, or
    `claude_desktop_config.json` for Claude Desktop:

    ```json
    {
      "mcpServers": {
        "ailoud": { "command": "ailoud", "args": ["mcp"] }
      }
    }
    ```

=== "opencode"

    `opencode.jsonc`:

    ```jsonc
    {
      "mcp": {
        "ailoud": {
          "type": "local",
          "command": ["ailoud", "mcp"],
          "enabled": true
        }
      }
    }
    ```

=== "Any other client"

    Run `ailoud mcp` and speak MCP over stdio.

Check it works:

```
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' | ailoud mcp
```

It serves the same library the CLI uses, in both directions.

## Ask it things

```
Which of my standups mentioned the rollback?
Summarise last week's 1:1 with Ben. He is my report.
Tag the untagged recordings for me.
```

## Tools

**Reading**

| Tool                 | Returns                                                |
| -------------------- | ------------------------------------------------------ |
| `list_recordings`    | the library, with tags and whether a transcript exists |
| `list_untagged`      | recordings that cannot be filtered by context yet      |
| `list_tags`          | every tag, with counts                                 |
| `search_transcripts` | matching lines with timestamps and speakers            |
| `get_transcript`     | a **file path**, not the text                          |
| `list_speakers`      | who spoke, and their names                             |
| `list_reports`       | saved summaries                                        |
| `get_report`         | a **file path**                                        |
| `list_templates`     | the summary shapes available                           |
| `job_status`         | a `transcribe` or `summarize` job's state              |

**Writing**

| Tool               | Does                                     |
| ------------------ | ---------------------------------------- |
| `annotate`         | titles, notes, tags, speaker names       |
| `import_recording` | adds files to the library                |
| `transcribe`       | starts speech-to-text, in the background |
| `summarize`        | starts a report, in the background       |
| `create_template`  | adds a summary shape                     |

**Deleting**

| Tool               | Does                                              |
| ------------------ | ------------------------------------------------- |
| `delete_recording` | two calls; see [below](#deleting-takes-two-calls) |
| `delete_report`    | two calls                                         |

## Background jobs

### `transcribe` refuses without speakers and languages

The first call without them gets this instead of a job id:

```json
{
  "error": "transcribe needs the speaker count and the expected languages",
  "why": "declared languages stop whisper reporting Polish for a Russian stretch, which then comes back as phonetic nonsense; a known speaker count is more reliable than letting the diarizer infer one",
  "guess": { "languages": ["ru", "en"], "from": "filename \"standup-ru-en.wav\"" },
  "ask": "Ask the user how many people speak on this recording and in which languages. Offer the guess above, plus your own reading of the name, and let them correct it. Ask per recording when the recordings differ.",
  "then": "call transcribe again with speakers and languages"
}
```

`guess` is `null` when the recording's name, title and tags give no hint.
`speakers` accepts a positive integer or `"unknown"`; `languages` accepts
codes such as `["ru", "en"]` or `["auto"]`.

### The job cycle

`transcribe` and `summarize` return at once, with a job id to poll:

```
transcribe(recordingIds: [...], speakers: 2, languages: ["ru", "en"])
-> { "jobId": "01M1Y5F04PS6VQ0FCP8HAS2JZ9", "kind": "transcribe",
     "poll": "call job_status with this id; a few minutes apart is often enough" }

job_status(jobId: "01M1Y5F04PS6VQ0FCP8HAS2JZ9")
-> { "state": "running", "percent": 46, "stage": "detecting", ... }
```

Poll every minute or two; polling faster does not make the work finish sooner.
With no `jobId`, `job_status` lists what is running plus the five most recent
finished jobs.

An id `job_status` does not recognise is reported as UNKNOWN, not as a
failure -- a pruned or mistyped id is a different fact from a job that ran and
failed:

```json
{ "error": "no such job: nosuchjob", "hint": "call job_status with no id to list" }
```

The state document:

| Field        | Meaning                                                      |
| ------------ | ------------------------------------------------------------ |
| `id`         | the job id                                                   |
| `kind`       | `transcribe` or `summarize`                                  |
| `state`      | `running`, `done` or `failed`                                |
| `percent`    | 0-100, approximate, never goes backwards                     |
| `stage`      | what it is doing right now, e.g. `detecting`, `transcribing` |
| `etaSeconds` | present once there is enough of the run to estimate from     |
| `recordings` | `{ total, done }`                                            |
| `declared`   | the speakers and languages given to `transcribe`, or null    |
| `startedAt`  | when the job began, ISO 8601                                 |
| `finishedAt` | when it ended, ISO 8601, or null while running               |
| `log`        | a **file path**, not the log text                            |
| `result`     | set on success; a finished `summarize` carries `reportId`    |
| `error`      | one message, set on failure                                  |

`log` is a path for the same reason `get_transcript` returns one: the engine
writes far more than an agent needs, and it is only worth reading after
something fails.

A finished `summarize` job's `result` carries a `reportId`; read it with
`get_report`.

## How it behaves

The server tells the agent six rules before its first call.

**Tag everything.** Tags are the only way to ask for "the recordings about this
project". `list_recordings` flags untagged ones and counts them, and
`list_untagged` exists so an agent can offer to fix them.

**Search before reading.** `search_transcripts` answers "where was this
discussed" in a few hundred bytes. Reading a transcript costs thousands of
tokens.

**Transcripts arrive as files.** `get_transcript` writes a temporary file and
returns the path, the line count and the duration. The agent reads the part it
needs with its own tools. The directory is removed when the server stops.

**Context lives in the agent's memory.** `summarize` takes a short `context`;
AILoud does not remember it between calls. The agent keeps it and passes it
again.

**Transcribing refuses without speakers and languages.** `transcribe` will
not start until the agent declares both; see [Background
jobs](#background-jobs) for the refusal itself and what it returns instead.

## Deleting takes two calls

The first call deletes nothing. It describes what would go and returns a
token:

```json
{
  "status": "confirmation required",
  "willDelete": [{ "id": "01M1B2...", "title": "Backend standup", "tags": ["standup"] }],
  "notDeleted": "the original files these were imported from",
  "recoverable": false,
  "confirmationToken": "6f1c...",
  "nextStep": "Show willDelete to the user. If they agree, call again with this confirmationToken."
}
```

Only a second call carrying that token deletes anything.

The token is single-use, expires in ten minutes, lives only in the server
process, and is bound to the exact ids it was issued for. The tools also carry
`destructiveHint`, so a client that gates destructive tools gates these.

## Prompts

| Prompt               | Does                                                                       |
| -------------------- | -------------------------------------------------------------------------- |
| `catch-up`           | answers a question the cheap way: search, then read only what it points at |
| `tidy-library`       | finds untagged recordings and proposes tags                                |
| `summarise-properly` | picks a template, checks for an existing report, passes context            |

## Resources

Transcripts and reports are addressable, with id completion:

```
ailoud://recording/{id}/transcript
ailoud://report/{id}
```

For clients that let you attach context directly.
