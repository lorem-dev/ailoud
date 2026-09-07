# CLI Reference

Every command lives under the noun it acts on, as in
[`docker container ls`](https://docs.docker.com/reference/cli/docker/container/ls/)
and [`gh pr list`](https://cli.github.com/manual/gh_pr_list).

```
ailoud --help
ailoud audio --help
ailoud audio summarize --help
```

## Shape

```
ailoud audio|recordings   import transcribe summarize search ls show annotate rm
ailoud report|reports     ls show rm
ailoud job|jobs           ls show rm
ailoud template|templates ls show new
ailoud mcp
ailoud doctor
ailoud setup
```

## Letters

The same letter means the same verb in every group.

| Letter | Verb            |
| ------ | --------------- |
| `i`    | `import`        |
| `t`    | `transcribe`    |
| `s`    | `summarize`     |
| `f`    | `search` (find) |
| `l`    | `ls`            |
| `v`    | `show` (view)   |
| `a`    | `annotate`      |
| `r`    | `rm`            |
| `n`    | `new`           |

```
ailoud audio f "rollback"
ailoud report l
```

The old top-level spellings still work: `ailoud ls`, `ailoud show`,
`ailoud rm`, `ailoud annotate`, `ailoud import`, `ailoud transcribe`,
`ailoud summarize`, `ailoud search`.

## audio import

```
ailoud audio import <path...> [--title <text>] [--notes <text>] [--tag <tag>]
```

| Option           | Does                                |
| ---------------- | ----------------------------------- |
| `--title <text>` | title for the imported recording    |
| `--notes <text>` | free-form notes                     |
| `--tag <tag>`    | tag everything imported; repeatable |

## audio transcribe

```
ailoud audio transcribe [ids...] [options]
```

| Option                | Does                                                    |
| --------------------- | ------------------------------------------------------- |
| `--lang <codes>`      | `ru`, or `ru,en` for several, or `auto`                 |
| `--model <name>`      | override the configured model                           |
| `--force`             | re-transcribe recordings that already have a transcript |
| `--multilingual`      | segment by speech and language, transcribe each run     |
| `--diarize`           | attribute segments to speakers                          |
| `--speakers <n>`      | known number of speakers                                |
| `--tag <tag>`         | tag these recordings; repeatable                        |
| `--max-cpu <percent>` | share of this machine to use, 1 to 100                  |
| `--no-gpu`            | do not use the GPU, even where a binary supports it     |
| `--denoise <mode>`    | `auto`, `on` or `off`                                   |
| `--detach`            | start the work in the background and print a job id     |

With no ids, transcribes everything that has no transcript yet.

## audio search

```
ailoud audio search <query...> [options]
```

| Option             | Does                                          |
| ------------------ | --------------------------------------------- |
| `--tag <tag>`      | only recordings carrying this tag; repeatable |
| `--lang <code>`    | only segments in this language                |
| `--recording <id>` | only this recording                           |
| `--limit <n>`      | at most this many hits (default 50)           |
| `--all`            | every transcript, not only the newest         |
| `--json`           | JSON instead of text                          |

## audio summarize

```
ailoud audio summarize [ids...] [options]
```

| Option                | Does                                                |
| --------------------- | --------------------------------------------------- |
| `--tag <tag>`         | summarise everything carrying this tag; repeatable  |
| `--template <name>`   | which shape; see `ailoud template ls`               |
| `--context <text>`    | a sentence the transcript does not say              |
| `--lang <code>`       | write the summary in this language                  |
| `--fresh`             | re-read transcripts instead of stored reports       |
| `--no-save`           | do not store the summary                            |
| `--max-cpu <percent>` | share of this machine to use, 1 to 100              |
| `--detach`            | start the work in the background and print a job id |

## audio ls

```
ailoud audio ls [--tag <tag>] [--json]
```

## audio show

```
ailoud audio show <id> [options]
```

| Option              | Does                                          |
| ------------------- | --------------------------------------------- |
| `--format <format>` | `text`, `json`, `srt`, `vtt` (default `text`) |
| `--speakers`        | list who spoke, instead of the transcript     |
| `--speaker <who>`   | only this speaker                             |
| `--transcript <id>` | a specific transcript instead of the newest   |

## audio annotate

```
ailoud audio annotate <id> [options]
```

| Option                   | Does                                                         |
| ------------------------ | ------------------------------------------------------------ |
| `--title <text>`         | the recording's title                                        |
| `--notes <text>`         | free-form context                                            |
| `--speaker <label=name>` | a real name for one label, e.g. `speaker_00=Ann`; repeatable |
| `--tag <tag>`            | group under a tag; repeatable                                |

## audio rm

```
ailoud audio rm <ids...> [--force]
```

Asks first. `--force` skips the question.

## report

```
ailoud report ls [--recording <id>] [--json]
ailoud report show <id> [--json]
ailoud report rm <ids...> [--force]
```

## job

```
ailoud job ls [--json]
ailoud job show <id> [--json]
ailoud job rm <id>
```

| Verb   | Letter | Does                                          |
| ------ | ------ | --------------------------------------------- |
| `ls`   | `l`    | list background jobs, newest first            |
| `show` | `v`    | print one job in full, including its log path |
| `rm`   | `r`    | forget a finished job; refuses a running one  |

`jobs` is the plural alias, as in `job|jobs` elsewhere. A job comes from
`audio transcribe --detach`, `audio summarize --detach`, or the MCP server.

`--job <id>` is an internal, hidden flag: it tells a detached child process,
or an MCP-spawned one, which job to report progress into. It is not something
to pass by hand.

## template

```
ailoud template ls [--json]
ailoud template show <name>
ailoud template new <name> --context <text> --heading <text> [--heading <text>]...
                          [--summary <text>] [--from <name>]
```

## mcp

```
ailoud mcp
```

Runs the library as an MCP server over stdio. See [MCP](../mcp.md).

## doctor

```
ailoud doctor [--fix] [--yes] [--model <name>] [--llm <choice>] [--llm-model <id>]
```

## setup

```
ailoud setup [--yes] [--model <name>] [--force] [--llm <choice>] [--llm-model <id>]
```

`--llm` is one of `local`, `claude-cli`, `claude-api`, `openai`, `skip`.

`setup --model <name>` switches the transcription model even when the
configured one is already healthy -- naming a different model is enough,
`--force` is not required. (`doctor --fix --model <name>` does not: it only
names what a genuinely missing model downloads as, same as before.) The old
model file is never deleted; `setup` prints its path so you can remove it by
hand. With no `--model` at all, `--force` reinstalls whatever is already
configured -- it never downgrades to the default `small`. If the configured
file matches no catalogue name (e.g. a whisper.cpp build of your own), it is
left alone instead, with a note saying so; pass `--model <name>` to move to a
catalogue model.

`--force` reinstalls everything ailoud needs, even when every check already
passes: ffmpeg, whisper.cpp, every whisper model. Use it to replace a
corrupted file `doctor` cannot see is broken. If you use a local summariser
(`--llm local`), it also reinstalls llama.cpp and re-downloads its 2.1 GB
model; a hosted summariser (Claude, OpenAI) is untouched either way.

## self completions

```
ailoud self completions install [--shell <ids>] [-y]
ailoud self completions uninstall [--shell <ids>]
ailoud self completions update
ailoud self completions print <shell>
```

Shells: `bash`, `zsh`, `fish`. Fish autoloads its own completions directory,
so `install` and `uninstall` never touch a fish startup file; bash and zsh
both get a marker block added to (or removed from) `~/.bashrc` /
`~/.zshrc`. `setup --yes` installs none of these; accept its prompt, pass
`--completions` to get them without asking, or `--no-completions` to skip
the prompt and decline.

## Exit codes

| Code | Means                 |
| ---- | --------------------- |
| `0`  | ok                    |
| `1`  | failure               |
| `2`  | usage error           |
| `3`  | environment not ready |

## Ids

Any unambiguous prefix of at least two characters works.

```
ailoud audio show 01M1B2
```

An ambiguous prefix says how many matched and shows the first few.

## Piping

Decoration and colour appear only on a terminal. Pipe any command and you get
plain, stable text.

```
ailoud audio ls --json | jq '.[].id'
ailoud audio show ID001 --format srt > subtitles.srt
```
