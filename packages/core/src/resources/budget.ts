/** What this machine offers, as far as it can be read. */
export interface CpuTopology {
  /** Every logical CPU the process may run on. At least 1. */
  readonly logical: number;
  /**
   * Performance cores, or null when the platform does not report the split.
   * Only Apple Silicon reports it today; see providers/system/cpuTopology.ts
   * for why Linux is deliberately not guessed at.
   */
  readonly performance: number | null;
}

/** How much of the machine each engine may take. */
export interface ResourceBudget {
  /** The ceiling: what an engine that scales with threads may use. */
  readonly threads: number;
  /**
   * The share handed to engines with a measured optimum below the ceiling,
   * capped below it: the speaker diarizer and the VAD speech segmenter. Not
   * named after either one, on purpose -- both were measured to the same
   * optimum, by different mechanisms, and a field named after only one of
   * them would invite the next reader to hand the other engine the full
   * ceiling.
   *
   * MEASURED on 607 s of speech, sherpa-onnx diarizer, 8 performance cores:
   *
   *   1 thread  120.0 s      6 threads  45.2 s   <- fastest
   *   2 threads  72.6 s      7 threads  56.5 s
   *   4 threads  50.3 s      8 threads  66-122 s
   *                         10 threads 105.6 s
   *
   * The binary holds two ONNX sessions, each with its own intra-op pool, so N
   * threads per pass oversubscribes a machine with N performance cores. Handing
   * this engine the full ceiling would have made diarization slower than it was
   * before this feature existed.
   *
   * MEASURED on 607 s of speech, whisper-vad-speech-segments, same machine:
   *
   *   1 thread  5.62 s      6 threads  2.17 s   <- fastest
   *   2 threads  3.38 s      7 threads  3.01 s
   *   4 threads  2.38 s      8 threads  3.88 s
   *
   * A different mechanism reaches the same optimum: this binary runs one
   * small model, where thread coordination overhead dominates past a handful
   * of threads rather than two ONNX sessions competing for cores. Same
   * number, different reason -- which is exactly why this field is not named
   * after either engine.
   */
  readonly cappedThreads: number;
  /** False means: pass the engine's disable-GPU flag, where one exists. */
  readonly gpu: boolean;
}

export const DEFAULT_MAX_CPU_PERCENT = 90;

/**
 * How many threads the capped engines must stay clear of, counted down from
 * the base. At `base - 1` the measured curve is already worse than at
 * `base - 2`, and at `base` it collapses. Measured against the diarizer and
 * the VAD segmenter both; see `ResourceBudget.cappedThreads`.
 */
const CAPPED_HEADROOM = 2;

function clamp(value: number, low: number, high: number): number {
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

/**
 * Turns a percentage into a thread count per engine.
 *
 * An out-of-range or non-finite percent falls back to the default instead of
 * throwing: validating user input belongs to the CLI, and this function sits
 * on the transcription path, where a resource hint may never be the thing
 * that fails a run.
 */
export function resourceBudget(
  topology: CpuTopology,
  options: { readonly maxCpuPercent?: number; readonly gpu?: boolean } = {},
): ResourceBudget {
  const requested = options.maxCpuPercent;
  const percent =
    requested !== undefined && Number.isFinite(requested) && requested >= 1 && requested <= 100
      ? requested
      : DEFAULT_MAX_CPU_PERCENT;

  // `performance` wins where it is known, because efficiency cores make
  // whisper.cpp slower rather than faster. Both counts are floored at 1: a
  // zero-thread flag would make every engine refuse to start.
  const base = Math.max(1, Math.round(topology.performance ?? topology.logical));
  const threads = clamp(Math.round((base * percent) / 100), 1, base);
  const cappedThreads = Math.min(threads, Math.max(1, base - CAPPED_HEADROOM));

  return { threads, cappedThreads, gpu: options.gpu ?? true };
}
