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
  `stt.diarization.embeddingModel`, and `stt.diarization.threshold` (default
  `0.6`).
- `laud setup` and `laud doctor --fix` provision the diarizer and its models
  the same way as whisper.cpp. Its `doctor` checks are optional: they report
  state but never make `doctor` fail on their own, since `--diarize` is
  opt-in. Diarization is not available on Linux arm64, because sherpa-onnx
  publishes no generic build for that target -- only vendor NPU builds that
  cannot run on an ordinary ARM machine.
