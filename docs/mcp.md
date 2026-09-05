# MCP

`ailoud mcp` serves your library to an AI agent over
[MCP](https://modelcontextprotocol.io/). The agent can search it, summarise it
and tag it.

## Set it up

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
