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
