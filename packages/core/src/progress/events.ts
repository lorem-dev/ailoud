/**
 * Where a long-running pipeline has got to.
 *
 * `fraction` is omitted for a stage whose progress cannot be measured -- a
 * diarizer pass reports its name and nothing else, because inventing a
 * number for it would be a lie the caller cannot detect. See honesty rule 2
 * in the design.
 */
export interface ProgressEvent {
  readonly stage: string;
  /** 0..1 across the whole run, not within the stage. Absent when unmeasurable. */
  readonly fraction?: number;
}

/**
 * Where progress goes. Core does no I/O, so a caller supplies this and
 * decides whether it becomes a spinner, a file, or nothing at all -- the
 * same arrangement `TranscribeDeps.onWarning` already uses.
 *
 * An implementation must not throw. Callers guard it anyway, because the
 * rule that a progress failure never costs a transcription has to hold by
 * structure rather than by trust.
 */
export type OnProgress = (event: ProgressEvent) => void;
