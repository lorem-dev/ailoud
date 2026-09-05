# Getting Started

## Install

!!! note
AILoud is not published to npm yet. Build from source for now. The
published install will land here.

=== "From source"

    Needs [Node.js](https://nodejs.org/) 24+ and
    [pnpm](https://pnpm.io/installation) 11+.

    ```
    git clone https://github.com/lorem-dev/ailoud.git
    cd ailoud
    pnpm install
    pnpm build
    pnpm link --global
    ```

    Check it:

    ```
    ailoud --version
    ```

=== "npm (soon)"

    ```
    npm install -g ailoud
    ```

## Set up the tools

AILoud needs `ffmpeg` and a speech-to-text engine. `setup` installs them:

```
ailoud setup
```

It prints what it will install and how much it will download, then asks once.
For an unattended run:

```
ailoud setup --yes --llm local
```

`setup` asks which language model to use for summaries. Pick one:

| Choice       | Needs                                                                 |
| ------------ | --------------------------------------------------------------------- |
| `local`      | a 2.1 GB download, then nothing leaves your machine                   |
| `claude-cli` | [Claude Code](https://claude.com/claude-code) installed and signed in |
| `claude-api` | `ANTHROPIC_API_KEY`                                                   |
| `openai`     | `OPENAI_API_KEY`                                                      |
| `skip`       | nothing; summaries stay off until you come back                       |

Check the result any time:

```
ailoud doctor
```

See [Configuration](usage/configuration.md) for the config file, and
[Troubleshooting a check](usage/configuration.md#when-doctor-is-unhappy) when
`doctor` is unhappy.

## Your first transcript

```
ailoud audio import ~/Recordings/standup.m4a --tag standup
ailoud audio transcribe
ailoud audio ls
```

```
01M1B2W5EG3SG628QEZCGAKP33  00:00:40  en  "Let us meet at the harbor before..."
```

Read it:

```
ailoud audio show 01M1B2
```

Ids are long, so any unambiguous prefix works -- as in
[docker](https://docs.docker.com/reference/cli/docker/container/ls/).

## Your first summary

```
ailoud audio summarize 01M1B2
```

```
Decisions
- Ann: cut the fixture to ten thousand rows today

Open questions
- Ben: CI takes twenty minutes; on next week's agenda
```

Every summary is saved:

```
ailoud report ls
ailoud report show SUM0
```

## Next

- [Recordings](usage/recordings.md) -- tags, speakers, two languages.
- [Search](usage/search.md) -- find a sentence without reading a transcript.
- [Templates](usage/templates.md) -- shape a summary for a 1:1 or a design review.
- [MCP](mcp.md) -- give an agent access to the library.
