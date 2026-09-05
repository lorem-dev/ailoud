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

### Supported agents

| Agent      | Scopes          | Config                         | Rules file                           |
| ---------- | --------------- | ------------------------------ | ------------------------------------ |
| `claude`   | project, global | `.mcp.json` / `~/.claude.json` | `CLAUDE.md`                          |
| `codex`    | project, global | `.codex/config.toml`           | `AGENTS.md`                          |
| `opencode` | project, global | `opencode.jsonc`               | `AGENTS.md`                          |
| `gemini`   | project, global | `.gemini/settings.json`        | `GEMINI.md`                          |
| `hermes`   | global only     | `~/.hermes/config.yaml`        | `~/.hermes/AGENTS.md`                |
| `copilot`  | global only     | `~/.copilot/mcp-config.json`   | `~/.copilot/copilot-instructions.md` |

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

=== "Claude Code"

    `.mcp.json` in your project, or `~/.claude.json` for every project:

    ```json
    {
      "mcpServers": {
        "ailoud": { "command": "ailoud", "args": ["mcp"] }
      }
    }
    ```

=== "Claude Desktop"

    `claude_desktop_config.json`:

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

It serves the same library the CLI uses. Anything you import in the shell is
visible to the agent, and the other way round.

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

**Writing**

| Tool               | Does                               |
| ------------------ | ---------------------------------- |
| `annotate`         | titles, notes, tags, speaker names |
| `import_recording` | adds files to the library          |
| `transcribe`       | runs speech-to-text                |
| `summarize`        | writes and saves a report          |
| `create_template`  | adds a summary shape               |

**Deleting**

| Tool               | Does                                              |
| ------------------ | ------------------------------------------------- |
| `delete_recording` | two calls; see [below](#deleting-takes-two-calls) |
| `delete_report`    | two calls                                         |

## How it behaves

The server tells the agent four rules before its first call.

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
laud://recording/{id}/transcript
laud://report/{id}
```

For clients that let you attach context directly.
