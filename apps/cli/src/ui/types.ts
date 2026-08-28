import type { Recording, Transcript } from '@laud/core';

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
}

/**
 * The only interface through which commands produce human-facing output.
 * A command states what happened; the active implementation (`PlainUi` or
 * `PrettyUi`) decides how that looks.
 *
 * Deliberately not part of this interface: raw JSON (`ls --json`, `show
 * --format json`) and transcript data (`show`'s text/srt/vtt output). Both
 * go straight to stdout through `CliContext.write` instead, undecorated in
 * either mode -- deviating from the recording's actual content is not an
 * option, and neither is emitting something `JSON.parse` cannot read back.
 */
export interface Ui {
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
  transcribed(recording: Recording, transcript: Transcript, segmentCount: number): void;

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
