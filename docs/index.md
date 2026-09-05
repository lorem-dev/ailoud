# AILoud

Transcribe audio and video into a local library. Search it, summarise it, keep
the reports.

Everything runs on your machine. Speech-to-text is local. Summaries can be
local too, or use Claude or OpenAI if you prefer.

```
ailoud audio import ./recordings --tag standup
ailoud audio transcribe
ailoud audio search "rollback"
ailoud audio summarize ID001 --template one-on-one
```

## Start here

- [Getting Started](getting-started.md) -- install it, transcribe your first file.
- [Recordings](usage/recordings.md) -- import, transcribe, tag, annotate.
- [Search](usage/search.md) -- find where something was said.
- [Summaries](usage/summaries.md) -- make reports and read them back.
- [MCP](mcp.md) -- let an agent use your library.

## What it is good at

| You want                                           | Use                                                                  |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| A meeting turned into text                         | [`ailoud audio transcribe`](usage/recordings.md#transcribe)          |
| To find one sentence in 40 hours of audio          | [`ailoud audio search`](usage/search.md)                             |
| Notes from a 1:1, shaped like 1:1 notes            | [`--template one-on-one`](usage/templates.md)                        |
| Two languages in one recording                     | [`--lang ru,en`](usage/recordings.md#two-languages-in-one-recording) |
| Who said what                                      | [`--diarize`](usage/recordings.md#speakers)                          |
| An agent to answer questions about your recordings | [MCP](mcp.md)                                                        |

## Links

- [Source](https://github.com/lorem-dev/ailoud)
- [Releases](https://github.com/lorem-dev/ailoud/releases)
- [Changelog](https://github.com/lorem-dev/ailoud/blob/main/CHANGES.md)
- [Contributing](https://github.com/lorem-dev/ailoud/blob/main/CONTRIBUTING.md)
