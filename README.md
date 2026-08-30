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

On a fresh machine, run `laud setup` first -- see "First run: `laud setup`"
under "External tools" below for what it installs and how to run it
unattended.

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

`transcribe` picks one language for the whole recording by default, which is
right for the overwhelming majority of recordings: a single speaker, or
several speakers sharing one language. For a recording that switches
language mid-way -- a call that starts in English and continues in Russian,
say -- that default silently discards whichever language loses the
per-recording vote. `--multilingual` is the opt-in fix: it finds the speech
in the recording, detects the language of each stretch, and transcribes each
language separately, so a switch produces multiple segments instead of one
segment in the wrong language:

```shell
laud transcribe ID001 --multilingual
```

It costs real time to do this: language detection runs once per ~2-second
window of speech, at roughly half a second per window, on top of the
transcription itself. A long recording of continuous speech in one language
pays that cost for no benefit, which is why `--multilingual` is not the
default.

`--multilingual` needs a second model beyond the one `transcribe` already
uses: a voice-activity-detection (VAD) model, configured separately at
`stt.whisperCpp.vadModel` (see "Configuration and storage" below). Without
one configured, `transcribe --multilingual` exits 3 and names the missing
config key, the same way it would for the missing whisper.cpp model; `laud
doctor` reports the same gap ahead of time.

Because it works by dividing detected speech into windows at least 1.5
seconds long, a single stretch of speech roughly 2 to 3 seconds long is
never subdivided: splitting it in two would put both halves under that
floor, so it is left whole. A language switch that falls entirely inside
such a stretch stays invisible to `--multilingual`, and is transcribed as
whichever language wins that stretch. This is a deliberate trade-off, not a
bug, but it is worth knowing about if a transcript is compared word for word
against the audio.

`--multilingual` has a second, larger gap, and this one is not a deliberate
trade-off: it only transcribes the stretch from the start of the first
speech span the voice-activity detector finds to the end of the last one.
Any audio outside that range -- a quiet opening line the detector never
marks as speech, or a soft aside after the last detected span -- is never
sliced out and never reaches whisper at all, and is silently missing from
the transcript with no warning. The single-pass default has no such gap: it
hands whisper the whole recording and lets whisper's own voice detection
decide what counts as speech. Disclosing this is the point of writing it
down here, since eliminating silent loss from a code-switched recording is
the entire reason `--multilingual` exists.

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
nine checks -- `ffmpeg` presence, `ffprobe` presence, the whisper binary, the
whisper model file, the VAD binary, the VAD model file, the config file, the
database path and its integrity, and the media root -- with a fix for each
failing check. The VAD checks only matter for `--multilingual`, but `doctor`
reports them either way. See section 12 of the design doc for the exit code
convention `doctor` failures use. Add `--fix` to have it install or download
whatever failed, using the same engine `laud setup` uses -- see "First run:
`laud setup`" under "External tools" below.

## External tools

`laud` depends on tools it does not bundle:

- **`ffmpeg` and `ffprobe`** -- probing and format conversion. Verified by
  `laud doctor`.
- **`whisper-vad-speech-segments`** (also from whisper.cpp) and a **VAD model
  file** -- speech detection for `transcribe --multilingual` only; the
  single-language default does not need either. Configured at
  `stt.whisperCpp.vadBinary` and `stt.whisperCpp.vadModel`, and checked by
  `laud doctor`.
- **`whisper-cli`** (whisper.cpp) and a **model file** -- local speech to
  text. The binary and model path are set in the config file, described
  below, and checked by `laud doctor`.

### First run: `laud setup`

The fastest way to get all of the above is to let laud install it:

```shell
laud setup
```

`setup` runs the same checks `doctor` does, prints what is missing, the exact
command line of every install it will run (including any `sudo`), and how
much it will download, asks once for confirmation, then installs ffmpeg,
installs whisper.cpp, and downloads a transcription model -- writing
whatever it installed into `config.yaml`. Checks that already pass are left
alone, so running `setup` again on an already-provisioned machine reports
nothing to do. A check that failed but has no automated repair -- a corrupt
database is the only one -- is reported with its manual fix, and the command
exits non-zero rather than claiming everything is in place.

- `--yes` skips the confirmation prompt. It is required (not just
  convenient) when there is no terminal to ask on -- CI, a script, anything
  with stdin that is not a TTY -- because `setup` refuses to install
  software or download a model unattended without it, and names `--yes` in
  the error rather than hanging.
- `--model <name>` picks which transcription model to download: `tiny`,
  `base`, `small` (the default), `medium`, or `large-v3-turbo`, trading
  download size and speed for accuracy. Without it, an interactive run
  prompts for a choice; a non-interactive run defaults to `small`, the model
  `--multilingual` was tuned against.

If the environment drifts after that -- an OS update removes a binary, a
model file gets deleted -- `laud doctor --fix` runs the exact same
provisioning engine as `setup`. Both act on exactly the checks that are
currently failing, and both skip the ones that pass; the difference is only
which command you reach for. `setup` is the first-run entry point, and prints
nothing but the plan; `doctor --fix` prints the full check report first, so
you see what is wrong before you see what it proposes to do:

```shell
laud doctor --fix
laud doctor --fix --yes --model tiny
```

It takes the same `--yes` and `--model` flags, for the same reasons, and
only prompts for a model choice when a transcription-model download is
actually part of the plan -- `doctor --fix` on a machine that is only
missing ffmpeg asks nothing.

`setup` and `doctor --fix` provision macOS (via Homebrew) and Linux x64/arm64
(via whisper.cpp's own prebuilt release tarball -- there is no apt package
for it) automatically. **Windows is not provisioned automatically.** `setup`
detects Windows up front, prints the manual steps, and exits without
downloading anything. On Windows, or on a Linux CPU architecture other than
x64/arm64, install the pieces by hand as described next.

Neither command will run an installer it cannot supervise: with no terminal
attached (CI, a pipe), an install that could prompt -- `sudo apt-get`, and
`brew`, which asks about the Xcode command line tools -- is reported with the
exact command to run by hand instead of being spawned into a stdin that will
never answer.

### Manual install (fallback)

- **ffmpeg and ffprobe**
  - macOS: `brew install ffmpeg`
  - Linux (Debian/Ubuntu): `sudo apt-get install ffmpeg`
  - Windows: install a build from https://ffmpeg.org/download.html and put
    `ffmpeg` and `ffprobe` on `PATH`.
- **whisper.cpp** (`whisper-cli`, and, for `--multilingual`,
  `whisper-vad-speech-segments`)
  - macOS: `brew install whisper-cpp` puts both on `PATH`.
  - Linux (x64/arm64): there is no apt package for whisper.cpp. Download the
    prebuilt tarball matching your CPU from the whisper.cpp releases page,
    tag `b4938`: `whisper-bin-ubuntu-x64.tar.gz` or
    `whisper-bin-ubuntu-arm64.tar.gz`. Extract it somewhere permanent and
    keep the whole tree together -- the binaries load their shared
    libraries (`libwhisper.so`, `libggml*.so`) from their own directory, so
    moving or symlinking a single binary out of it breaks the loader. Point
    `stt.whisperCpp.binary` and `stt.whisperCpp.vadBinary` (see
    "Configuration and storage" below) at the extracted `whisper-cli` and
    `whisper-vad-speech-segments`.
  - Windows, or a Linux CPU architecture other than x64/arm64: no prebuilt
    asset is published; build whisper.cpp from source and point
    `stt.whisperCpp.binary` / `stt.whisperCpp.vadBinary` at the result.
- **Model files** -- download a ggml transcription model (e.g.
  `ggml-small.bin`) from
  https://huggingface.co/ggerganov/whisper.cpp, and, for `--multilingual`,
  the VAD model `ggml-silero-v5.1.2.bin` from
  https://huggingface.co/ggml-org/whisper-vad. Set `stt.whisperCpp.model`
  and `stt.whisperCpp.vadModel` to their paths.

Either way, `laud doctor` confirms what is still missing.

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
