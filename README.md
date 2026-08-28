# laud

`laud` is a command-line tool that turns audio and video recordings into
transcripts, keeps them in a local library, and (in a later milestone) answers
questions over one or many of them through a large language model.

## Two engine layers

`laud` keeps two engine layers strictly separate, because no single vendor
covers both:

- **Speech to text (STT)** turns audio into timestamped segments. Local
  whisper.cpp, or a cloud API.
- **Large language model (LLM)** summarizes and reasons over transcript text.
  Anthropic, an OpenAI-compatible endpoint (Ollama, LM Studio, OpenAI), or an
  agent CLI driven as a subprocess.

Neither Ollama, LM Studio, nor the Anthropic API accepts audio, so the STT
layer is never satisfied by the LLM layer, and vice versa. The two ports
never merge into one interface.

The full design -- the data model, the CLI surface across all milestones,
and the reasoning behind these choices -- lives in the maintainer's planning
notes under `.superpowers/`, which is deliberately not tracked in git. This
README and [AGENTS.md](./AGENTS.md) describe everything the code actually
ships.

## Status

The current milestone (M1) ships a working library and transcription
pipeline: `import`, `transcribe`, `ls`, `show`, and `doctor`. Collections,
tags, full-text search, export, and LLM summaries are later milestones and do
not exist yet.

## Install

`laud` has no published release yet. Build it from source:

```shell
git clone <this-repository>
cd laud
pnpm install
pnpm build
```

Run the CLI from the built output. `apps/cli/dist/bin/laud.js` has a shebang
that already disables the experimental-SQLite warning, so running it
directly is the simplest option:

```shell
./apps/cli/dist/bin/laud.js --help
```

If you invoke it through `node` instead, the shebang is bypassed and you
must pass the flag yourself, or every command prints an `ExperimentalWarning`
before its actual output:

```shell
node --disable-warning=ExperimentalWarning apps/cli/dist/bin/laud.js --help
```

While working on laud itself, `pnpm laud` builds and runs in one step and
forwards its arguments, so there is no separate build to remember:

```shell
pnpm laud doctor
pnpm laud import ./recordings
```

The build it runs is incremental -- `tsc -b` recompiles only the packages
whose inputs changed -- so an unchanged tree costs a fraction of a second.
Its progress line goes to stderr, leaving `pnpm laud ls --json` safe to
pipe.

To get a real `laud` on your `PATH`, link the package globally:

```shell
cd apps/cli
npm link
laud --help
```

## CLI quick start

The binary is `laud` below, once linked onto your `PATH` as shown above.
Every command exits non-zero on failure.

Human-facing output is decorated -- left gutter, status glyphs, a spinner
while `transcribe` waits on whisper.cpp -- whenever stdout is a real
terminal, and plain otherwise. Pipe any command (`laud ls | cat`, or into a
file or another program) and it drops the decoration automatically, so
scripts and `laud ls --json | jq` see the same stable text either way.

Import a file or a directory of audio/video, then transcribe what has no
transcript yet:

```shell
laud import ./recordings
laud transcribe
```

`import` against a directory only looks at files directly inside it; it does
not walk subdirectories. A directory with no media files directly inside it
(empty, only non-media files, or media nested one level deeper) fails with
`No media files found in <path>.`

`transcribe` with no ids defaults to every recording that has no transcript,
which is the loop after a bulk import. `--force` re-transcribes recordings
that already have one, and requires explicit ids so it cannot silently
re-run the whole library:

```shell
laud transcribe ID001 --force
```

List the library, and show a transcript:

```shell
laud ls
laud ls --json
laud show ID001
laud show ID001 --format srt
```

Check that your machine is set up correctly:

```shell
laud doctor
```

`doctor` is a first-class command, not a diagnostic afterthought: it reports
seven checks -- `ffmpeg` presence, `ffprobe` presence, the whisper binary,
the whisper model file, the config file, the database path and its
integrity, and the media root -- with a fix for each failing check. See
section 12 of the design doc for the exit code convention `doctor` failures
use.

## External tools

`laud` depends on tools it does not bundle:

- **`ffmpeg` and `ffprobe`** -- probing and format conversion. Verified by
  `laud doctor`.
- **`whisper-cli`** (whisper.cpp) and a **model file** -- local speech to
  text. The binary and model path are set in the config file, described
  below, and checked by `laud doctor`.

## Configuration and storage

- Config: `$XDG_CONFIG_HOME/laud/config.yaml`, default `~/.config/laud`.
- Data: `$XDG_DATA_HOME/laud`, default `~/.local/share/laud`, holding
  `laud.db` and the `media/` tree.
- Secrets (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) will come from the
  environment or from Locksmith, never from the config file, and will never
  be logged. This is a later-milestone feature; M1 does not use an LLM and
  reads no such secret yet.

## Development

See [AGENTS.md](./AGENTS.md) for the workspace layout, conventions, and the
local development skills, and [CONTRIBUTING.md](./CONTRIBUTING.md) for
commit rules and the dependency license policy. The gate:

```shell
corepack enable
pnpm install
pnpm build
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:cov
```

`pnpm watch` keeps `tsc -b` running in the background and rebuilds on save,
which pairs well with `pnpm test:watch` in a second terminal.

## License

Apache-2.0. See [LICENSE](./LICENSE).
