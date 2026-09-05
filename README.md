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

If you know which languages the recording holds, say so instead. Naming two
or more turns multilingual mode on by itself:

```shell
laud transcribe ID001 --lang ru,en
```

That is worth doing, and not only for brevity. whisper's language detector
answers with any language in the world and cannot be restricted, so on a
Russian/English recording it will sometimes report Polish for a Russian
stretch -- and that stretch is then transcribed as Polish, coming back as
phonetic nonsense. Declaring the set turns such an answer from a discovery
into a knowable mistake, which laud repairs from the surrounding stretches.

Declaring also buys sharper switching. Detection needs roughly five seconds
of one language to be reliable, while conversational turns run two to four
seconds, so the two pull against each other. Undeclared, laud must favour
reliability and use a wide window, which can swallow a short turn of the
other language whole. Declared, mis-detections are repairable, so it uses a
narrow window and keeps up with the conversation.

`--lang` also takes a single code, which forces that language for the whole
recording in one pass, and `auto`, which is the default.

It costs real time to do this: language detection runs once per window of
speech, at roughly half a second per window, on top of the transcription
itself. A long recording of continuous speech in one language pays that cost
for no benefit, which is why multilingual mode is not the default.

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

`--diarize` opts into speaker diarization: a second, local pass over the
audio attributes each transcript segment to a speaker (`speaker_00`,
`speaker_01`, ...) by running a standalone diarizer and joining its output to
the transcript by time overlap. Off by default, for the same reason
`--multilingual` is: it costs a model download and a second pass over the
audio, and most recordings are one person.

```shell
laud transcribe ID001 --diarize
laud transcribe ID001 --diarize --speakers 2
```

`--speakers <n>` tells the diarizer how many speakers to expect. Measured
during this feature's design, an explicit count was exact far more often
than letting the diarizer infer the count from the audio, so give it
whenever you know it. `--speakers` without `--diarize` is a usage error, not
a silent no-op, since without `--diarize` there is nothing for it to inform.

Diarization cannot be installed automatically on Linux arm64: sherpa-onnx,
the tool laud uses, publishes no generic build for that CPU architecture in
the pinned release -- only vendor NPU builds (axcl, axera, rknn), which
cannot run on an ordinary ARM machine. Diarization itself still works there
if you build sherpa-onnx from source and point `stt.diarization.binary` at
the result; what is missing is the prebuilt download, not the feature. See
"External tools" below for the platforms `laud setup` covers on its own.

Naming speakers and separating overlapping speech are both out of scope:
output is always `speaker_00`, `speaker_01`, and so on, and a segment where
two people talk at once is attributed to whichever speaker dominates it.
`show --format text` prints the speaker before each attributed segment;
`--format json` carries the same value in its `speaker` field. SRT and VTT
are unchanged -- subtitle formats have their own speaker conventions.

Every command lives under the noun it acts on, the way `docker container ls`
and `gh pr list` do. There are two nouns, plus `doctor` and `setup`:

```shell
laud audio import ./recordings
laud audio transcribe
laud audio summarize ID001
laud audio ls
laud audio show ID001
laud audio annotate ID001 --title "Standup"
laud audio rm ID001

laud report ls
laud report show SUM0
laud report rm SUM0

laud template ls
laud template show one-on-one
laud template new retro --context "A sprint retro." --heading "Went well" --heading Actions
```

Every verb has a one-letter alias, and the same verb takes the same letter in
both groups, so the letters are worth learning once rather than per noun:

| letter | verb          |     | letter | verb         |
| ------ | ------------- | --- | ------ | ------------ |
| `l`    | `ls`          |     | `i`    | `import`     |
| `v`    | `show` (view) |     | `t`    | `transcribe` |
| `r`    | `rm`          |     | `s`    | `summarize`  |
| `a`    | `annotate`    |     |        |              |

```shell
laud audio l
laud audio v ID001
laud report l
```

The group is singular with the plural as an alias, so `laud report rm SUM0`
reads as removing one report rather than all of them; `laud recordings l` and
`laud reports l` work too. A bare `laud audio` prints its verbs.

The old top-level spellings keep working and always will -- `laud import`,
`laud transcribe`, `laud summarize`, `laud ls`, `laud show`, `laud rm`, `laud
annotate` -- the same bargain `docker ps` struck with `docker container ls`.
They are left out of `laud --help` so that it shows the shape of the tool
rather than every command twice.

```shell
laud ls
laud ls --json
laud show ID001
laud show ID001 --format srt
```

Summarise one recording, or a tagged group of them in a single pass:

```shell
laud summarize ID001
laud summarize ID001 ID002
laud summarize --tag standup
```

`summarize` has no default selection, unlike `transcribe`: summarising the
whole library by accident costs minutes of local inference, or real money on
a hosted model.

`--lang <code>` chooses the language of the summary; without it the summary is
written in the language of the recording, because laud exists for recordings
that are not in English and a translation nobody asked for is not a summary.
Codes are turned into names before the model sees them -- "Write in Russian"
holds far better than "Write in ru".

`--template` says what kind of conversation this is, which decides the
headings, and `--context` hands the model the sentence or two the transcript
does not say:

```shell
laud audio summarize ID001 --template one-on-one \
  --context "Ann is Ben's manager; this is their fortnightly."
```

The headings differ because the questions do: a one-to-one is about agreements
and concerns, a solution decision is about what was rejected and what would
change the answer. `laud template ls` lists what is available:

| template                | shape                                                              |
| ----------------------- | ------------------------------------------------------------------ |
| `meeting`               | decisions, open questions, notes -- the default                    |
| `one-on-one`            | agreements, concerns raised, follow-ups                            |
| `performance-review`    | strengths, areas to improve, evidence, agreed goals, disagreements |
| `architecture-planning` | decisions, options considered, trade-offs, risks                   |
| `solution-decision`     | decision, reasoning, rejected alternatives, what would change it   |
| `offsite`               | themes, decisions, actions                                         |

Templates are written out as files in `$XDG_CONFIG_HOME/laud/templates/`, one
YAML file each, on first use. They are files rather than something buried in
the binary because a template is prose about how to summarise, and prose nobody
can see cannot be improved. Edit one and the edit takes effect; a file you have
edited is never replaced by an update. Write your own and it is a peer of the
shipped ones:

```shell
laud template ls
laud template show solution-decision
laud template new retro --from one-on-one \
  --heading "Went well" --heading "Did not" --heading Actions
```

The template and the context are stored with the report, so what a report was
asked to be can be read back later.

Every summary is saved. `laud report ls` lists them, `laud report show <id>`
prints one, and `laud report rm <id>` deletes one:

```shell
laud report ls
laud report ls --recording ID001
laud report show SUM0
laud report rm SUM0
```

Deleting a report never touches a recording or its transcript: a report is
derived, and what it was derived from is what the library is for.

A summary of several recordings reuses each one's stored summary instead of
re-reading its transcript, which is where the saving is: ten meetings from ten
stored summaries costs a fraction of ten transcripts. Asking again about a
_single_ recording always re-reads its transcript -- a summary of a summary is
a game of telephone, each pass further from what anybody said. `--fresh`
forces the transcripts either way, and `--no-save` keeps nothing.

While the work runs there is a spinner, and where progress is countable it is
counted: `Summarising portion 3/8 (37%)`. A report longer than 30 lines opens
in your pager, where up, down and `q` behave as they do in `git` and `man`.

For each recording, laud writes a transcript file into a directory that exists
only for the length of the run -- `record-yyyymmddhhmmss.txt`, from the
recording's own date, with `-001` appended if two recordings share a second.
Each file opens with a header the prompt is told to read:

```
Title: Backend standup
Recorded: 2026.08.24 09:30
Tags: standup, backend
Participants: Ann, Ben, speaker_01 (unnamed)

[00:00] Ann: Right, let's keep this short.
```

That is where tags, the recording's date and the speaker names set through
`annotate` reach the model, so points are attributed to a person rather than
to `speaker_00` and a group summary can say which meeting each point came
from. An unnamed diarizer label is listed but marked: it has to appear, or the
model cannot attribute the lines that carry it, and it has to be marked, or it
gets attributed as though it were somebody's name.

The prompt reaches a spawned model through a file or stdin, never as an
argument. A transcript of any length passes `ARG_MAX` -- about a megabyte on
macOS, less once the environment is counted -- and the spawn then fails with
`E2BIG`, which is not something a user can fix.

`laud setup` asks which engine to use and writes the answer to
`llm.provider`; `--llm local|claude-cli|claude-api|openai|skip` answers it
without a prompt, which is what an unattended run needs. Picking anything but
`local` skips the 2.1 GB download entirely. `skip` configures nothing and
leaves `summarize` unavailable until you come back to it -- `doctor` reports
that as `n/a`, not as a failure. The providers:

| `llm.provider`      | Reaches                                                        | Credential                                                            |
| ------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------- |
| `llama-cpp`         | a local GGUF model through `llama-cli`                         | none; nothing leaves the machine                                      |
| `openai-compatible` | OpenAI, and local servers like llama-server, Ollama, LM Studio | `LAUD_LLM_API_KEY` or `OPENAI_API_KEY`, and none for a local endpoint |
| `anthropic`         | Claude, through Anthropic's API                                | `LAUD_LLM_API_KEY` or `ANTHROPIC_API_KEY`                             |
| `claude-cli`        | Claude, through the Claude Code CLI                            | the CLI's own sign-in -- a subscription, not a key                    |

After the engine, `setup` asks which model, and asks the provider itself
rather than carrying a list that goes stale: `GET /v1/models` on Anthropic or
OpenAI. Both need a key, so with none set the question is skipped, the
configured model is kept, and `setup` says which variable to export to get the
choice. The subscription route has no listing endpoint, so it offers the
Claude Code tiers -- `opus`, `sonnet`, `haiku` -- which are aliases that
follow the newest model of each tier and so never need updating. `--llm-model
<id>` answers up front and is taken verbatim, with no request made: an id the
provider does not know is rejected at the first summary, with its message.

One thing to watch: neither endpoint reports a model's context window, so
picking a model does not adjust `contextTokens`. The defaults suit the current
Claude and GPT-4o-class models; choosing a small-context model (say
`gpt-3.5-turbo`, 16k against a 128k default) means setting
`llm.openaiCompatible.contextTokens` by hand, or the first oversized request
comes back as a context error from the API.

Claude is reachable both ways deliberately, and `setup` asks which rather
than guessing: a subscription is not an API key, and someone who already pays
for one should not have to buy API credit to summarise their own recordings.
`claude-cli` borrows the CLI's existing sign-in and runs one non-interactive
completion with tools switched off. laud does not install Claude Code itself.

Whichever engine is chosen, `doctor` reports its state and never exits
non-zero over it: summarising is opt-in, so an unset key, an unsigned-in CLI
and a deliberate `skip` all read as `n/a`.

Check that your machine is set up correctly:

```shell
laud doctor
```

`doctor` is a first-class command, not a diagnostic afterthought: it reports
thirteen checks -- `ffmpeg` presence, `ffprobe` presence, the whisper binary,
the whisper model file, the VAD binary, the VAD model file, the diarizer
binary, the two diarization model files, the language model, the config file,
the database path and its integrity, and the media root -- with a fix for
each failing check. A fourteenth, the local language-model runner, is added
only when `llm.provider` is `llama-cpp`, since the hosted providers have no
runner to check. The VAD checks, the three diarization checks, and the
language-model check are all optional the same way: because `--multilingual`,
`--diarize` and `summarize` are opt-in, a failing check for one of them still
reports its state, but never makes `doctor` exit non-zero by itself -- only
checks unrelated to those features do.
See section 12 of the design doc for the exit code convention `doctor`
failures use. Add `--fix` to have it install or download whatever failed,
using the same engine `laud setup` uses -- see "First run: `laud setup`"
under "External tools" below.

## External tools

`laud` depends on tools it does not bundle:

- **`ffmpeg` and `ffprobe`** -- probing and format conversion. Verified by
  `laud doctor`.
- **`whisper-vad-speech-segments`** (also from whisper.cpp) and a **VAD model
  file** -- speech detection for `transcribe --multilingual` only; the
  single-language default does not need either. Configured at
  `stt.whisperCpp.vadBinary` and `stt.whisperCpp.vadModel`. Checked by `laud
doctor`, but because `--multilingual` is opt-in, a failing VAD check is
  reported as `n/a` rather than `FAIL` and never makes `doctor` exit
  non-zero on its own -- see "CLI quick start" above.
- **`whisper-cli`** (whisper.cpp) and a **model file** -- local speech to
  text. The binary and model path are set in the config file, described
  below, and checked by `laud doctor`.
- **`sherpa-onnx-offline-speaker-diarization`**, a **segmentation model**,
  and an **embedding model** -- speaker attribution for `transcribe
--diarize` only; the single-speaker default needs none of it. Configured
  at `stt.diarization.binary`, `stt.diarization.segmentationModel`, and
  `stt.diarization.embeddingModel`, plus `stt.diarization.threshold` (the
  clustering threshold used when `--speakers` is not given; default `0.6`)
  and `stt.diarization.threads` (threads for both diarizer passes; default
  `4`, the setting diarization speed was measured at -- the binary's own
  default of 1 is about half as fast). Checked by `laud doctor`, but
  because `--diarize` is opt-in, a failing diarization check is reported as
  `n/a` rather than `FAIL` and never makes `doctor` exit non-zero on its own
  -- see "CLI quick start" above.

- **`llama-cli`** (llama.cpp) and a **GGUF model file** -- local
  summarisation for `laud summarize` only, and only when `llm.provider` is
  `llama-cpp`; the other three providers need neither. Configured at
  `llm.llamaCpp.binary` and `llm.llamaCpp.model`. Checked by `laud doctor`,
  but because `summarize` is opt-in, a failing language-model check is
  reported as `n/a` rather than `FAIL` and never makes `doctor` exit non-zero
  on its own.

### First run: `laud setup`

The fastest way to get all of the above is to let laud install it:

```shell
laud setup
```

`setup` runs the same checks `doctor` does, prints what is missing, the exact
command line of every install it will run (including any `sudo`), and how
much it will download, asks once for confirmation, then installs ffmpeg,
installs whisper.cpp, downloads a transcription model, installs the
sherpa-onnx diarizer and downloads its two models -- writing whatever it
installed into `config.yaml`. The diarizer is provisioned right alongside the
rest even though `--diarize` is opt-in: its `doctor` checks are optional (they
cannot make `doctor` fail), but `setup` and `doctor --fix` still act on any
check that is failing, optional or not.

The language model is the one piece `setup` asks about, because the choices
are not interchangeable: it offers llama.cpp with Qwen2.5-3B (a 2.1 GB
download, nothing leaves the machine), Claude, OpenAI, or skipping for now;
Claude then asks subscription or API key, and every hosted route then asks
which model. Only the local answer downloads
anything; the rest write `llm.provider` and name the environment variable
still needed. The question is asked before the plan is printed, so the
download total and the command list you consent to already reflect it. Answer
it up front with `--llm`, which is also what an unattended run uses --
`--llm local` without a terminal is the default, so existing `setup --yes`
scripts keep the behaviour they had. Checks that already pass are
left alone, so running `setup` again on an already-provisioned machine
reports nothing to do. A check that failed but has no automated repair -- a
corrupt database is the only one -- is reported with its manual fix, and the
command exits non-zero rather than claiming everything is in place.

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

The sherpa-onnx diarizer follows a narrower map, because upstream publishes
fewer prebuilt binaries than whisper.cpp does: **only macOS arm64 and Linux
x64 have a generic build in the pinned release**, and those are the only two
platforms `setup` and `doctor --fix` can install the diarizer on. Everywhere
else -- an Intel Mac, Linux arm64 (where the only aarch64 assets upstream
ships are vendor NPU builds that do not run on an ordinary ARM machine), any
other Linux architecture, Windows -- there is no prebuilt asset to fetch, so
building sherpa-onnx from source and pointing `stt.diarization.binary` at
the result is the route. That is a real route, not a dead end: laud only
ever invokes the binary the config names. In all those cases the install
action is skipped with an explanation rather than aborting the rest of the
plan, the same way an unsupported whisper.cpp architecture is handled.

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
- **sherpa-onnx** (`sherpa-onnx-offline-speaker-diarization`), for
  `--diarize`
  - macOS arm64 and Linux x64: download the `v1.13.6` release tarball from
    the sherpa-onnx releases page and extract it somewhere permanent, the
    same as whisper.cpp above. Point `stt.diarization.binary` at the
    extracted binary.
  - Every other platform -- macOS on Intel, Linux arm64, any other Linux
    CPU architecture, Windows: no prebuilt asset is published, so build
    sherpa-onnx from source and point `stt.diarization.binary` at the
    resulting `sherpa-onnx-offline-speaker-diarization`. On Linux arm64 the
    only aarch64 assets upstream ships are vendor NPU builds (axcl, axera,
    rknn) that do not run on an ordinary ARM machine, which is why there is
    nothing to download there -- a source build still works.
  - Download the segmentation model
    (`sherpa-onnx-pyannote-segmentation-3-0.tar.bz2`, extract `model.onnx`)
    and the embedding model
    (`3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx`) from the
    same sherpa-onnx releases page, and set `stt.diarization.segmentationModel`
    and `stt.diarization.embeddingModel` to their paths.

Either way, `laud doctor` confirms what is still missing.

## Configuration and storage

- Config: `$XDG_CONFIG_HOME/laud/config.yaml`, default `~/.config/laud`.
- Data: `$XDG_DATA_HOME/laud`, default `~/.local/share/laud`, holding
  `laud.db` and the `media/` tree.
- Secrets (`LAUD_LLM_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) come
  from the environment, never from the config file, and are never logged: a
  config file gets pasted into issues and committed by accident.
  `LAUD_LLM_API_KEY` wins over the vendor variable, so a laud-specific key can
  override a shared one. A variable exported but left blank counts as no key.

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
