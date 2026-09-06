# Architecture

A pnpm workspace of three packages.

```
ailoud/
  packages/
    core/         domain model, ports, db schema, pipelines, formatters
    providers/    port implementations: ffmpeg, sqlite, whisper.cpp, fs
  apps/
    cli/          commander command tree, binary `ailoud`, MCP server
  e2e/            Jest suite driving the built binary
  fixtures/       short audio samples with reference transcripts
  docs/           this site
```

## Dependency direction

```
apps/cli  ->  packages/providers  ->  packages/core
apps/cli  ->  packages/core
```

It never points the other way. `packages/core` does no I/O at all: it holds
the domain, the ports, and pure logic.

## Ports

`core` declares interfaces; `providers` implements them.

| Port                    | Implementation                                      |
| ----------------------- | --------------------------------------------------- |
| `Fs`, `Clock`, `Ids`    | `node:fs`, `Date`, ULID                             |
| `AudioTool`             | ffmpeg / ffprobe                                    |
| `RecordingStore`        | `node:sqlite`                                       |
| `TranscriptionProvider` | whisper.cpp                                         |
| `SpeechSegmenter`       | whisper VAD                                         |
| `Diarizer`              | sherpa-onnx                                         |
| `Summarizer`            | llama.cpp, Claude CLI, Anthropic, OpenAI-compatible |

Swapping an engine means writing one adapter. Nothing in `core` changes.

## Database

SQLite through `node:sqlite`, with `PRAGMA foreign_keys = ON`.

| Table                          | Holds                                           |
| ------------------------------ | ----------------------------------------------- |
| `recording`                    | one imported file                               |
| `transcript`                   | one transcription run of a recording            |
| `segment`                      | one timestamped line, with speaker and language |
| `segment_fts`                  | the full-text index over `segment.text`         |
| `speaker`                      | a real name for a diarizer label                |
| `tag`                          | a tag on a recording                            |
| `summary`, `summary_recording` | a report and what it covers                     |

Migrations are a list; `SCHEMA_VERSION` is its length. They run on open and
only ever move forward.

## The summary prompt

```
node scripts/eval-summary-prompt.mjs --runs 3
node scripts/eval-summary-prompt.mjs --models haiku --cases one-on-one
```

The prompt is measured, not guessed. Each variant runs three times over seven
transcripts -- English, Russian, code-switched, long, multi-recording,
undiarized, and a language override -- across haiku, sonnet and opus. Every run
is scored for stated facts, invented facts, language and length.

Change the prompt or a template's headings, then re-run it. The previous
measurement does not carry over.
