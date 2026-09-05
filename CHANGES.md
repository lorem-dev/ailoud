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
- `laud summarize --lang <code>` writes the summary in a chosen language. The
  default stays the recording's own language. A code is turned into a name
  before the model sees it: "Write in Russian" holds far better than
  "Write in ru".
- Every summary is saved -- schema version 5, a `summary` table with a join to
  the recordings it covers. A summary is not a property of a recording: one can
  cover several, and the same recording can be summarised again in another
  language or by another model without the earlier one becoming wrong. The
  provider and model are stored with it, because they explain the text.
- `laud reports` lists saved summaries and `laud reports <id>` prints one, with
  `--recording` to filter, `--json`, and id prefixes as everywhere else.
- A group summary reuses each recording's stored summary instead of re-reading
  its transcript, which is where the saving is. Asking again about a single
  recording always re-reads the transcript: a summary of a summary is a game of
  telephone, each pass further from what anybody actually said. `--fresh`
  forces transcripts, `--no-save` keeps nothing.
- Each recording is written to `record-yyyymmddhhmmss.txt`, from its own date,
  with `-001` appended when two recordings share a second -- one overwriting
  the other would drop a whole meeting out of the summary. The files live in a
  directory that exists only for the length of the run.
- Each file opens with a header the prompt is told to read: title, recording
  date, tags and participants. That is how tags, the audio's own date and the
  names set through `annotate` reach the model. An unnamed diarizer label is
  listed but marked "(unnamed)": it has to appear, or the model cannot
  attribute the lines carrying it, and it has to be marked, or it is attributed
  as though it were a person's name.
- The prompt reaches a spawned model through a file (llama.cpp `-f`) or stdin
  (the Claude CLI), never as an argument. A transcript of any length passes
  ARG_MAX -- about a megabyte on macOS -- and the spawn then fails with E2BIG.
- A spinner while the summary runs, and a percentage where the work is
  countable: `Summarising portion 3/8 (37%)`. The combining pass is counted
  with the portions, because a bar that reaches 100% and keeps spinning is
  worse than one that reaches 90%. The undecorated path prints one line per
  stage and nothing at all for a single request, so a redirected report is
  still just the report.
- A report over 30 lines opens in the user's pager, as `show` already did.
- The prompt was rewritten against measurement rather than taste:
  `scripts/eval-summary-prompt.mjs` runs variants three times each over seven
  transcripts -- English, Russian, code-switched, long, multi-recording,
  undiarized, and a language override -- on haiku, sonnet and opus, and scores
  each run for stated facts, invented ones, language and length. The shipped
  prompt scores 60/63, evenly across the three models; the previous one scored
  30/36 on a smaller set, failing length on every larger-model run.
- Named headings beat prose: prose lost a stated fact on a code-switched
  transcript on repeated sonnet runs, where the headings gave that fact
  somewhere to live.
- The word cap is load-bearing, not tidiness. Uncapped, sonnet and opus ran
  270-330 words on a long transcript on every run.
- "Name the speaker for every point" made both larger models invent "Speaker A"
  and "Speaker B" on every run of an undiarized recording. Telling them to omit
  the speaker instead traded that for "(speaker not identified)" after every
  bullet; the shipped wording forbids both, and all three models are clean.
- Two measurement bugs found and fixed in the harness itself, both of which had
  reported failures that were not real: a Cyrillic ratio that counted Russian
  participant names and so called a clean English summary Russian, and a
  speaker-label pattern that matched the model honestly saying "speaker not
  identified". Both were caught by reading the outputs rather than the scores.
- Commands are grouped by the noun they act on: `laud audio ls|show|annotate|rm`
  and `laud report ls|show|rm`. Verbs that bring something into being --
  `import`, `transcribe`, `summarize` -- stay at the top level. That is the
  shape `docker` and `gh` settled on, and it is what keeps `laud --help`
  readable as the library grows.
- The group is singular with the plural as an alias -- `laud report rm SUM0`
  reads as removing one report, while `laud reports rm SUM0` reads as removing
  all of them. `recordings` and `reports` both resolve.
- The short spellings keep working and are not deprecated: `laud ls`, `laud
show`, `laud rm`, `laud annotate`. `docker ps` still works years after
  `docker container ls` became canonical, because the short form is what hands
  and scripts already know. They are hidden from the top-level help so it shows
  the shape of the tool instead of every command twice. The e2e suite, which
  drives `laud ls` and `laud show`, passes untouched -- which is the proof the
  compatibility is real rather than claimed.
- A bare `laud audio` prints its verbs instead of an error: someone typing it
  does not yet know them, and the list is the answer to that.
- `laud report rm` is new. Deleting a report never touches a recording or a
  transcript: a report is derived, and what it was derived from is what the
  library is for. It asks first, takes `--force`, refuses with no terminal, and
  resolves every id before deleting any of them -- half a deletion is the worst
  outcome when the user asked about a set.
- `import`, `transcribe` and `summarize` moved under `audio` as well, so every
  verb lives under the noun it acts on and the top level is two nouns plus
  `doctor` and `setup`. `laud --help` now shows the shape of the tool rather
  than a list that grows with every feature.
- Every second-level verb has a one-letter alias -- `l` ls, `v` show, `r` rm,
  `a` annotate, `i` import, `t` transcribe, `s` summarize -- and the same verb
  takes the same letter in both groups, so they are worth learning once instead
  of per noun. `v` for `show` because `s` belongs to `summarize`, and because
  `view` is what `gh` calls it anyway.
- The letters live in one table rather than beside each command, since the risk
  they carry is collision and a table is where that is visible. A test reads
  that table and fails on a duplicate, a missing letter, or one longer than a
  character.
- The old top-level spellings all keep working, `import`, `transcribe` and
  `summarize` included. The e2e suite drives `laud import`, `laud transcribe`,
  `laud ls` and `laud show`, and passes untouched.
- `laud audio summarize --template <name>` says what kind of conversation this
  is, which decides the summary's headings, and `--context <text>` hands the
  model the sentence or two the transcript does not say -- who these people are
  to each other, what the project is called, what happened last week.
- Six templates ship: `meeting` (the default), `one-on-one`,
  `performance-review`, `architecture-planning`, `solution-decision` and
  `offsite`. The headings differ because the questions do: a one-to-one is
  about agreements and concerns, a solution decision about what was rejected
  and what would change the answer.
- Templates are written out as YAML files under
  `$XDG_CONFIG_HOME/laud/templates/`, one per template, on first use. A
  template is prose about how to summarise, and prose nobody can see cannot be
  improved. Disk is the source of truth, so an edit takes effect -- and a file
  the user has edited is never overwritten, which is the difference between
  shipping defaults and destroying someone's work.
- `laud template ls|show|new` lists, prints and creates them. `new --from`
  starts from an existing template. A template needs a context sentence and at
  least two headings: one heading is a title, not a shape.
- `laud audio import --tag` tags at import. A tag is how a recording is found
  again by context, and the moment it is easiest to supply is while somebody is
  already thinking about what the file is; postponed, it stays undone.
- The caller's context sits above the rules in the prompt, not below them: it
  is what the recording IS, where the rules are how to write about it. It is
  labelled as the caller's, because an unlabelled sentence handed in from
  outside is indistinguishable from something a speaker said and gets
  attributed to one.
- Schema version 6 stores the template and the context with each report, for
  the same reason the model is stored: a report reused later as context is
  worth less if nobody can tell what it was asked to be.
- Measured, as before: the one-on-one template with caller context scores 3/3
  on haiku, sonnet and opus, and the whole set is 68/72. Changing the headings
  does not carry the previous measurement automatically, so the harness gained
  a template case.
- `laud template new one-on-one` on a machine that had never listed templates
  created a file shadowing a built-in, silently, because the built-ins had not
  been written out yet. `new` materialises them before it checks.
- `laud audio search <words>` finds where something was said. It returns the
  matching segments -- timestamp, speaker, line -- grouped by recording with
  each recording's tags in the heading, and never a whole transcript: "where
  was this discussed" is answered by a line, and handing back a thousand lines
  to find one is not an answer.
- Full-text, over the FTS index that has existed since schema version 1 and had
  no reader. It folds case in every language laud is for -- `встреча` finds
  `Встреча` -- which a `LIKE` search could not have done, since SQLite's
  `LOWER()` folds ASCII only.
- A trailing `*` is a prefix search, worth far more in an inflected language
  than in English, and a `"quoted run"` is a phrase. Everything else is matched
  literally: FTS5's own syntax has `AND`, `OR`, `NEAR`, `:` and `-` in it, so a
  raw query turns `don't` and `C++` into syntax errors and makes a transcript
  containing the word "AND" unsearchable for it.
- Only each recording's newest transcript is searched by default. One
  re-transcribed with `--force` holds the same words two or three times, and
  returning them all reads as several occurrences. `--all` searches every
  transcript.
- `--limit` is never silent: a listing that stops at the limit without saying
  so reads as "that is all there is".
- Schema version 7 adds the AFTER UPDATE trigger the FTS index never had. A
  statement rewriting a segment's text in place would have left the index
  holding the old words -- finding the recording by a phrase nobody says in it
  any more, and missing it by the phrase they do. Nothing in laud updates
  segment text today, so this closes a hole rather than fixing a symptom.
