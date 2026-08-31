# laud Changelog

## Development

### Added

- Initial project scaffolding: workspace, quality gate, and documents.
- `laud import` adds audio and video files, or whole directories, to a local
  library, skipping anything already stored.
- `laud transcribe` turns recordings into timestamped, language-detected
  transcripts with whisper.cpp.
- `laud ls` and `laud show` list the library and print a transcript as text,
  JSON, SRT, or VTT.
- `laud doctor` reports every missing tool, model, and permission, with how
  to fix each one.
- Runtime dependencies are pinned to exact versions, so an install never
  drifts to an untested release.
- Config lives at `$XDG_CONFIG_HOME/laud/config.yaml`, with two keys:
  `stt.whisperCpp.binary` and `stt.whisperCpp.model`.
- Every command exits with one of four codes: 0 ok, 1 failure, 2 usage, 3
  environment -- a scriptable, stable contract.
- `laud transcribe --multilingual` detects and preserves each language in a
  code-switched recording instead of tagging the whole thing with one.
- `laud setup` provisions a fresh machine -- ffmpeg, whisper.cpp, and a
  transcription model -- asking once for consent (`--yes` to skip it, e.g.
  in CI) and letting `--model` pick which model to download.
- `laud doctor --fix` runs the same provisioning engine as `setup`, acting on
  the checks that are currently failing, then re-checks.
- The setup plan names every command it will run, including any `sudo`, so
  consent is never given blind.
- `laud ls` names every language of a code-switched recording (`en+ru`), not
  only the dominant one. `--json` still carries the single stored code.
- Transcript previews are quoted and escaped, so trailing whitespace is
  visible and a transcript containing control characters cannot reprogram the
  reader's terminal. A clipped preview ends in `...`.
- A command that runs for more than a second reports how long it took
  (`Done in 1m 5.300s`), on failure as well as success.
- `laud setup` detects Windows up front and prints manual instructions
  instead of downloading anything.
- With no terminal, an install that could prompt is reported with its exact
  command rather than spawned and left to hang.
- A failing check with no automated repair, such as a corrupt database, is
  reported with its manual fix and exits non-zero.
- `laud transcribe --diarize` attributes each segment to a speaker with a
  local sherpa-onnx diarizer, joined to the transcript by time overlap;
  `--speakers <n>` gives the known speaker count, which measured more
  reliably than letting the count be inferred. `show --format text` prints
  the speaker when a segment has one, and `--format json` carries it in the
  existing `speaker` field; SRT and VTT are unchanged.
- Config gains `stt.diarization.binary`, `stt.diarization.segmentationModel`,
  `stt.diarization.embeddingModel`, `stt.diarization.threshold` (default
  `0.6`), and `stt.diarization.threads` (default `4`).
- `laud setup` and `laud doctor --fix` provision the diarizer and its models
  the same way as whisper.cpp. Its `doctor` checks are optional: they report
  state, shown as `n/a` rather than `FAIL`, but never make `doctor` fail on
  their own, since `--diarize` is opt-in. The prebuilt diarizer covers macOS
  arm64 and Linux x64 only -- sherpa-onnx publishes no generic build for
  Linux arm64 (only vendor NPU builds that cannot run on an ordinary ARM
  machine), for an Intel Mac, or for Windows, so on those platforms
  diarization needs sherpa-onnx built from source with
  `stt.diarization.binary` pointed at it.
- `laud doctor`'s `vad binary` and `vad model` checks are optional now, the
  same way the diarization checks are: `--multilingual` is opt-in, so a
  machine that never transcribes code-switched audio no longer carries a
  permanently failing `doctor` over it. `transcribe --multilingual` still
  exits 3 with an actionable message when the VAD model is not configured.
- `laud summarize <ids...>` and `laud summarize --tag <tag>` summarise one
  recording or a group with a language model. A group is summarised together
  rather than one at a time and stapled: "what came out of these
  conversations" is a different question from three separate answers, and the
  second is already available by running the command three times.
- Four engines behind one port, chosen with `llm.provider`. `llama-cpp` runs
  a local GGUF model the way whisper.cpp is run -- a binary, spawned per
  request, nothing leaving the machine. `openai-compatible` speaks the
  chat-completions shape, which covers OpenAI, most hosted alternatives, and
  local servers like llama-server, Ollama and LM Studio. `anthropic` calls
  Claude's own API. `claude-cli` reaches Claude through the Claude Code CLI.
- Claude is reachable both ways on purpose: by API key, and by subscription.
  A Claude subscription is not an API key, and someone who already pays for
  one should not have to buy API credit to summarise their own recordings.
  `claude-cli` borrows the CLI's existing sign-in; it runs one non-interactive
  completion with tools switched off, because summarising is a completion and
  an agent with file and shell access is not what was asked for.
- Anthropic gets its own adapter rather than a base-url swap on the OpenAI
  one: the two APIs differ in path, authentication header, a required version
  header, and where the reply's text lives. Pretending otherwise would have
  produced an adapter that looked generic and worked for one vendor.
- The API key is read from `LAUD_LLM_API_KEY`, or `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY` for the selected vendor -- from the environment, never from
  the config file: a config file gets pasted into issues and committed by
  accident. An exported-but-blank variable counts as no key, so `doctor`
  cannot report "key set" while every request comes back 401.
- A transcript too long for the model is summarised in parts and the parts
  combined, split on segment boundaries so no sentence is cut in half. The
  split is decided from the model's own context size.
- The prompt tells the model to answer in the transcript's language, and feeds
  it the speaker names set through `annotate`, so points are attributed to a
  person rather than to `speaker_00`.
- `summarize` has no default selection, unlike `transcribe`: summarising a
  whole library by accident costs minutes of local inference or real money on
  a hosted model.
- Recordings can be tagged, to group them: `annotate --tag standup` and
  `transcribe --tag standup`, repeatable, and `ls --tag standup` to see the
  group. Several tags narrow rather than widen -- a recording must carry all
  of them.
- `show` heads its output with `Transcript of 2026.08.31 07:01`, taken from
  the recording's own date where it has one and the import date otherwise.
  The heading lives in the frame, not the transcript, so a redirected file
  still holds only the transcript.
- A transcript longer than 30 lines opens in the system pager, where up, down
  and q already work the way they do in git and man. Never when output is
  redirected or piped.
- Speaker names are coloured, and only the names. Colours come from a
  hand-picked palette of mid-luminance shades so they are legible on a light
  terminal and a dark one, and are assigned per recording so two speakers can
  never share one. Colour is applied only when writing to a terminal.
- Text is padded after the speaker's name so every line begins in the same
  column.
- A speaker name is capped at 32 characters: it prints in front of every line
  that person says, and a description belongs in --notes.
- `laud annotate <id>` adds context to a recording: `--title`, `--notes`, and
  `--speaker label=name` (repeatable) to give a diarizer's `speaker_00` a real
  name. Named speakers feed the summaries planned for the next milestone, and
  make a transcript readable now.
- Names live in their own table keyed by recording and label, not written over
  the segments. The label is what the diarizer produced and the name is a
  human's annotation of it, so re-transcribing with `--force` re-runs
  diarization without losing the names -- verified on a real recording.
- `laud show <id> --speakers` lists who spoke, ordered by how much, with their
  names, segment counts and total speech. `--speaker <who>` shows only that
  speaker, matched by diarizer label or by the name you gave them, either
  case. A miss names the speakers the recording does have.
- Transcript text prints the name where a speaker has one, and the label where
  they do not.
- Ids can be abbreviated, as in docker: any prefix of at least two characters
  that picks out exactly one thing works wherever a full id does. That covers
  every command taking an id -- `show`, `transcribe`, `rm` -- and
  `show --transcript` as well. Case and surrounding whitespace do not matter.
- An ambiguous prefix is the ordinary case rather than the exception, because
  a ULID begins with a timestamp and recordings imported minutes apart agree
  for eight characters or more. So the error says how many matched, lists the
  first three with their source, and counts the rest -- enough to choose a
  longer prefix without going back to `laud ls`.
- Commands taking several ids resolve all of them before acting on any. A
  typo in the third of three cannot leave the first two already deleted.
- Recordings carry the date the audio was recorded, read from the container's
  own metadata (`creation_time`, which mp4 and mov usually have and wav
  usually does not). It is stored separately from the import timestamp rather
  than folded into it, so "when was this recorded" and "when did laud first
  see it" stay distinguishable; `recordedOrImportedAt` resolves the fallback
  at the point of use. A placeholder date -- the Unix epoch, or an unparseable
  tag -- is refused rather than stored, because 1970 would be silently wrong
  where null is merely unknown.
- Schema version 2 adds the column. Existing databases migrate in place, with
  their recordings kept and no date of their own, which is the truth: nothing
  knows retroactively when they were recorded.
- `laud rm <ids...>` deletes recordings from the library, with their
  transcripts and segments, and with laud's own copy of the audio. The file
  you imported from is never touched -- `import` copies into laud's storage
  and leaves the original where it is, and the confirmation says so. Deletion
  asks first; `--force` answers in advance, and with no terminal to ask on it
  refuses rather than assuming consent.
- Every id is checked before anything is deleted, so a typo in the third of
  three ids cannot leave the first two gone.
- Multilingual mode detects language per SPEAKER TURN when `--diarize` is on,
  instead of per fixed-size window, and decides each speaker's language from
  all of their turns pooled. Turns are the boundaries language actually
  changes on in a bilingual exchange, and pooling gives detection far more
  audio than any single two-second turn does -- which dissolves the trade
  between detecting reliably and localising a switch, rather than splitting
  it. The diarizer runs once and its turns are reused for both jobs.
- The audio fixtures now carry 400ms of silence between turns. Without it they
  were not conversations: voice-activity detection found one span in a
  36-second twelve-turn file, so it could not locate a single turn boundary
  and the multilingual code had to guess at them with windows. With the gaps
  it returns one span per turn, and transcription of the bilingual fixture
  went from five of six English turns lost to all twelve turns present.
- `transcribe --stt-lang <code>` is now `--lang <codes>` and takes a set:
  `--lang ru,en`. Naming two or more languages turns multilingual mode on by
  itself, since naming them IS the statement that the recording switches
  between them, and confines detection to that set.
- Detection is confined by repairing whisper's answer rather than restricting
  its input, which is not possible: it reports any language in the world, so
  on a Russian/English recording it would report Polish for a Russian stretch
  and then transcribe that stretch AS Polish, returning phonetic nonsense. An
  answer outside the declared set is now treated as a mis-detection and
  resolved from its neighbours.
- The detection window was measured rather than guessed, and now depends on
  whether a set was declared. Undeclared, a mis-detection is unrepairable, so
  the window is wide (5000ms) because detection needs about five seconds of
  homogeneous speech to be right. Declared, mis-detections are repairable, so
  the window is narrow (2000ms) to keep up with conversational turns: at
  5000ms with a declared set, five of six English turns in a 32-second
  conversation vanished into Russian-dominated windows.
- The window also adapts to the span it divides, so a short recording is
  never swallowed whole. A flat 5000ms window stopped splitting the
  3.46-second bilingual clip the feature was built for, silently losing its
  second language again.
- `laud setup` and `laud doctor --fix` take an exclusive lock on the data
  directory before provisioning, so two concurrent runs cannot delete or
  truncate scratch files out from under each other. A live lock is refused
  immediately, naming the other process's pid and when it started, rather
  than waiting -- provisioning can sit on a consent prompt for minutes. A
  stale lock (holder no longer running, or an empty/corrupt lock file left
  by a crash) is taken over automatically.
- `laud doctor` reports the language model, and `laud setup` can provision it.
  Both treat it as optional, the way the VAD and diarization checks are:
  `summarize` is opt-in, and a machine that only transcribes must not carry a
  permanently red `doctor` over a feature it never uses.
- The check knows what "configured" means for each provider, because they do
  not agree: a GGUF file and a runner on disk for `llama-cpp`, a key in the
  environment for the hosted APIs, a binary that runs for `claude-cli`.
  Whether a subscription is signed in is not checked -- that is not knowable
  without making a billable request, and `doctor` does not spend the user's
  money to answer a question. A local OpenAI-compatible endpoint is not asked
  for a key, since Ollama and llama-server want none.
- `laud setup` installs llama.cpp -- `brew` on macOS, a pinned release tarball
  on Linux, where every target laud supports is published -- and downloads
  Qwen2.5-3B-Instruct (Q4_K_M, about 2 GB) as the local summarisation model.
- The local runner and the local model are two `doctor` checks, not one. A
  check carries one remedy, so folding them together made `setup` download two
  gigabytes of GGUF and leave no `llama-cli` to run it -- without naming the
  install on the consent screen. The runner check appears only when
  `llm.provider` is `llama-cpp`.
- The consent screen counts the language model in its download total, and
  names `brew install llama.cpp` on macOS instead of the tarball it does not
  use there. Both made it ask for consent to something other than what would
  run, which is the one thing the plan exists to prevent.
- `doctor`'s undecorated output widens its name column to the longest check
  name. At a fixed width, `diarization segmentation model` ran into its own
  detail: `diarization segmentation modelnot configured`.
- `laud setup` asks which language model to set up instead of assuming the
  local one: llama.cpp with Qwen2.5-3B, Claude, OpenAI, or skip for now, with
  Claude asking subscription or API key as a second question. Guessing that
  one from whether the CLI happens to be installed would quietly put someone
  who has both on the route that costs money.
- Only the local answer downloads anything. The rest record the choice in
  `llm.provider` and name the credential still needed, so a machine that talks
  to a hosted engine no longer pays 2.1 GB for a runner it will never call.
- The question is answered before the plan is printed, because the answer
  changes the plan: the command list and the download total consented to are
  the ones that will run. `--llm local|claude-cli|claude-api|openai|skip`
  answers it up front, and is what an unattended run uses -- `local` remains
  the default with no terminal, so existing `setup --yes` scripts are
  unaffected.
- `skip` configures nothing and leaves `summarize` unavailable. Every outcome,
  that one included, is reported by `doctor` as `n/a` rather than a failure;
  a test now pins that for all four providers, which until now held only by
  the coincidence of each branch being marked optional.
- The action executor rejects an unhandled action kind at compile time. Its
  switch had no default, so a kind nobody wrote a case for was named in the
  plan, consented to, and then silently did nothing.
- After the engine, `laud setup` asks which model, and asks the provider for
  the list rather than shipping one: `GET /v1/models` on Anthropic or OpenAI.
  A built-in list was the alternative and is stale the day a vendor ships
  anything.
- Both endpoints need a key, so with none set the question is skipped, the
  configured model is kept, and the run says which variable to export to get
  the choice -- rather than picking one and not saying which. A listing that
  fails or times out is reported the same way and does not sink the rest of
  the plan.
- OpenAI's `/v1/models` is a catalogue of everything on the account, with
  nothing in the response marking which entries are chat models, so they are
  filtered out by id -- a denylist of substrings (`embedding`, `tts`,
  `whisper`, ...) rather than an allowlist of prefixes, so a new chat model
  appears the day it ships.
- Anthropic's list is paginated and is followed to the end. Stopping at the
  first page would have hidden models with nothing on screen to say so.
- The subscription route has no listing endpoint, so it offers the Claude Code
  tiers `opus`, `sonnet` and `haiku`: aliases, not pinned ids, so each follows
  the newest model of its tier and the list cannot go stale.
- `--llm-model <id>` answers up front and is taken verbatim, with no request
  made: validating it would put a network call in every unattended run, and an
  unknown id is rejected at the first summary with the provider's own message.
- The model is written into the block its provider reads -- `llm.anthropic`,
  `llm.openaiCompatible` or `llm.claudeCli` -- since a model id only means
  something inside one of them.
- Known gap: neither endpoint reports a context window, so choosing a model
  does not adjust `contextTokens`. Picking a small-context model needs that key
  set by hand; the symptom is a context error from the API on the first
  oversized request, not a silently truncated summary.
