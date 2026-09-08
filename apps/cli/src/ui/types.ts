import type { Recording, Remedy, Transcript } from '@ailoud/core';

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
   * Present when `ailoud setup` / `doctor --fix` can repair this check
   * without a human. Absent means the repair needs judgment -- see
   * `Remedy`'s doc comment.
   *
   * Attached on a PASSING check too, whenever `remedy` genuinely repairs the
   * exact thing this check inspects -- `ailoud setup --force` reads it off a
   * passing check to reinstall something that already works (a corrupted
   * file still passes an existence check; `--force` is the only way to
   * replace it). This supersedes the original rule ("attach a Remedy to
   * every failing Check ... never to a passing one"): that rule predates
   * `--force`, which needs exactly the checks a plain failing-only filter
   * throws away.
   *
   * The one thing that does NOT carry onto a passing check: a remedy that is
   * a SUBSTITUTE for the thing being checked -- an alternative path offered
   * only because the real thing is missing -- rather than a repair of it.
   * `checkLanguageModel`'s claude-cli branch is the example: it checks the
   * Claude Code CLI, but its remedy installs llama.cpp (a fallback local
   * model, offered when Claude Code isn't there), which does not repair
   * Claude Code at all. Carried onto a passing check, `--force` would
   * brew-install llama.cpp for someone whose Claude Code is fine and who
   * never asked for a local summariser -- so that check strips its own
   * `remedy` back off when it passes. When adding a check, ask whether its
   * remedy fixes what THIS check inspects, or offers an alternative for when
   * it can't be fixed; only the former belongs on the passing branch.
   *
   * `checkMediaRoot` is the one deliberate exception on the other side: its
   * remedy (`create-directory`) IS a repair, but it is left off the passing
   * branch anyway, because recreating an already-writable directory is a
   * pure no-op that would only add a line of noise to every `--force` plan.
   */
  readonly remedy?: Remedy;
  /**
   * True when this check reports the state of an opt-in feature rather than
   * something ailoud needs to run at all -- the diarizer today, since
   * `--diarize` is opt-in per recording. Absent (the default) means the
   * check is load-bearing: `ailoud` cannot do its job without it, the way it
   * cannot without ffmpeg or a transcription model.
   *
   * The distinction is `remedy`'s counterpart, one level up: `remedy` says
   * whether a failure can be repaired without a human; `optional` says
   * whether the failure means ailoud cannot run at all, or only that one
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
   * thrown `AiloudError`. Rethrows whatever `task` throws, unchanged, so the
   * process's exit code is decided the same way it always was.
   */
  frame<T>(label: string, task: () => Promise<T>): Promise<T>;

  /** A recording was imported, or was already present in the library. */
  imported(recording: Recording, alreadyPresent: boolean): void;

  /**
   * Runs `task`, the actual transcription work, decorating it with progress
   * feedback (a spinner naming `recording`, in pretty mode).
   *
   * `report(stage, fraction)` updates that feedback. Shaped like
   * `summarising`'s reporter but taking a fraction rather than done/total:
   * transcription progress is a proportion computed from weighted stages,
   * not a count of anything a reader would recognise.
   *
   * Returns whatever `task` resolves to, and rethrows whatever it throws, so
   * callers can treat this as a transparent wrapper around the call.
   */
  transcribing<T>(
    recording: Recording,
    task: (report: (stage: string, fraction: number) => void) => Promise<T>,
  ): Promise<T>;

  /**
   * Runs the summary work behind a spinner, with a way to say how far along it
   * is.
   *
   * `report(done, total)` updates the spinner: a percentage when `total` is
   * more than one, and just the stage name otherwise. A summary can take
   * minutes -- a local model on a long recording, or several hosted requests
   * one after another -- and a still cursor for minutes is indistinguishable
   * from a hang. Where the work is countable it is counted, because "portion 3
   * of 7" answers "how much longer" and a spinner alone does not.
   */
  summarising<T>(
    task: (report: (stage: string, done: number, total: number) => void) => Promise<T>,
  ): Promise<T>;

  /** A recording finished transcribing into `transcript`, with `segmentCount` segments. */
  /**
   * `languages` is every language the segments were spoken in, most-spoken
   * first (see summarizeLanguages in @ailoud/core). It is passed separately
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
   * whenever stdout is not a terminal, so `ailoud show ID --format srt >
   * out.srt` still produces a byte-exact subtitle file and `--format json`
   * still pipes into a parser.
   */
  content(text: string): void;

  /**
   * A passing remark about how the work is going -- not an outcome, not
   * payload. Used when a command is about to do something slow enough that
   * silence would look like a hang.
   */
  note(message: string): void;

  transcribed(
    recording: Recording,
    transcript: Transcript,
    segmentCount: number,
    languages: readonly string[],
  ): void;

  /** A recording already had a transcript and was left alone (no `--force`). */
  skipped(recording: Recording): void;

  /**
   * A recording removed from the library. `mediaRemoved` is false when
   * ailoud's copy of the audio was already gone -- worth saying, because the
   * difference between "deleted it" and "it was not there" is the difference
   * between a tidy library and a puzzle later.
   */
  deleted(recording: Recording, mediaRemoved: boolean): void;

  /** `transcribe` was asked to do something, and there was nothing to do. */
  nothingToTranscribe(): void;

  /** `ls` found no recordings in the library. */
  emptyLibrary(): void;

  /** `ls` found recordings: render one row per recording. */
  recordings(rows: readonly RecordingRow[]): void;

  /** `doctor` finished running its checks: render the full report. */
  checks(checks: readonly Check[]): void;

  /**
   * A status outcome that succeeded -- e.g. one file `mcp install` wrote, or
   * one project `self sync` actually refreshed. Distinct from `content()`,
   * which reports payload rather than an outcome, and from the frame's own
   * success status, which speaks for the whole command rather than one
   * outcome inside it. Used only where the thing being reported genuinely
   * carries an enumerated status -- decorating a line that is not one of
   * several possible outcomes would make this marker mean nothing.
   */
  success(message: string): void;

  /**
   * A non-fatal problem worth the user's attention, e.g. `--diarize` failing
   * to produce speaker labels. Distinct from the frame's own failure
   * reporting: the command otherwise succeeded, so this must not look like
   * the run itself failed.
   */
  warn(message: string): void;
}
