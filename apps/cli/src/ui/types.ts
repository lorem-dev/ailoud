import type { Recording, Remedy, Transcript } from '@laud/core';

/**
 * A single row of the human-readable `ls` listing. Distinct from the JSON
 * shape `ls --json` emits: `--json` bypasses the UI layer entirely (see
 * `Ui`'s doc comment), so it keeps its own row type in `commands/ls.ts`
 * rather than sharing this one.
 */
export interface RecordingRow {
  readonly id: string;
  readonly durationMs: number;
  readonly language: string | null;
  readonly preview: string;
}

/**
 * One `doctor` check result. Lives here, not in `commands/doctor.ts`, so
 * the UI layer -- which decides how a list of checks is rendered -- does
 * not need to import a command module to know the shape it is rendering.
 */
export interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly fix?: string;
  /**
   * Present when `laud setup` / `doctor --fix` can repair this check
   * without a human. Absent means the repair needs judgment -- see
   * `Remedy`'s doc comment.
   */
  readonly remedy?: Remedy;
  /**
   * True when this check reports the state of an opt-in feature rather than
   * something laud needs to run at all -- the diarizer today, since
   * `--diarize` is opt-in per recording. Absent (the default) means the
   * check is load-bearing: `laud` cannot do its job without it, the way it
   * cannot without ffmpeg or a transcription model.
   *
   * The distinction is `remedy`'s counterpart, one level up: `remedy` says
   * whether a failure can be repaired without a human; `optional` says
   * whether the failure means laud cannot run at all, or only that one
   * opt-in feature is unavailable until someone asks for it. A failing
   * optional check is still reported like any other -- it just does not
   * make `doctor` exit non-zero or `setup`/`doctor --fix` treat the
   * environment as not ready.
   */
  readonly optional?: true;
}

/**
 * The only interface through which commands produce human-facing output.
 * A command states what happened; the active implementation (`PlainUi` or
 * `PrettyUi`) decides how that looks.
 *
 * Payload output -- raw JSON (`ls --json`, `show --format json`) and
 * transcript data (`show`'s text/srt/vtt) -- goes through `content()` rather
 * than straight to stdout. That routing is what lets a terminal reader see
 * the payload inside the command's frame while a redirect still receives the
 * exact bytes: `PlainUi`, which is what runs whenever stdout is not a
 * terminal, writes it undecorated. Deviating from the recording's actual
 * content is not an option, and neither is emitting something `JSON.parse`
 * cannot read back.
 */
export interface Ui {
  /**
   * Opens a frame labeled `label`, runs `task` inside it, and always
   * closes the frame before returning or throwing -- with a success
   * status if `task` resolves, a failure status (naming the error) if it
   * rejects. Every command wraps its entire action in exactly one call to
   * this, so no run can leave a frame open on any exit path, including a
   * thrown `LaudError`. Rethrows whatever `task` throws, unchanged, so the
   * process's exit code is decided the same way it always was.
   */
  frame<T>(label: string, task: () => Promise<T>): Promise<T>;

  /** A recording was imported, or was already present in the library. */
  imported(recording: Recording, alreadyPresent: boolean): void;

  /**
   * Runs `task`, the actual transcription work, decorating it with
   * progress feedback (a spinner naming `recording`, in pretty mode).
   * Returns whatever `task` resolves to, and rethrows whatever it throws,
   * so callers can treat this as a transparent wrapper around the call.
   */
  transcribing<T>(recording: Recording, task: () => Promise<T>): Promise<T>;

  /** A recording finished transcribing into `transcript`, with `segmentCount` segments. */
  /**
   * `languages` is every language the segments were spoken in, most-spoken
   * first (see summarizeLanguages in @laud/core). It is passed separately
   * from `transcript.language`, which holds only the dominant one: showing
   * a single code for a code-switched recording tells the user something
   * untrue. Empty when the provider recorded no per-segment language, in
   * which case the renderer falls back to `transcript.language`.
   */
  /**
   * Payload a command was asked to produce: a transcript, or the JSON
   * behind `--json`. Distinct from every other method here, which reports
   * what happened rather than emitting content.
   *
   * `PrettyUi` renders it inside the open frame, so an interactive reader
   * sees one coherent block instead of a frame with content spilling out
   * around it. `PlainUi` writes it verbatim -- and `PlainUi` is what runs
   * whenever stdout is not a terminal, so `laud show ID --format srt >
   * out.srt` still produces a byte-exact subtitle file and `--format json`
   * still pipes into a parser.
   */
  content(text: string): void;

  transcribed(
    recording: Recording,
    transcript: Transcript,
    segmentCount: number,
    languages: readonly string[],
  ): void;

  /** A recording already had a transcript and was left alone (no `--force`). */
  skipped(recording: Recording): void;

  /** `transcribe` was asked to do something, and there was nothing to do. */
  nothingToTranscribe(): void;

  /** `ls` found no recordings in the library. */
  emptyLibrary(): void;

  /** `ls` found recordings: render one row per recording. */
  recordings(rows: readonly RecordingRow[]): void;

  /** `doctor` finished running its checks: render the full report. */
  checks(checks: readonly Check[]): void;
}
