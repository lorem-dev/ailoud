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
 * The absolute ceiling for the capped engines, regardless of machine size.
 *
 * An earlier revision capped `cappedThreads` relative to the base
 * (`max(1, base - 2)`) instead of with this absolute number. That was a wrong
 * generalisation from one machine, and it failed in both directions:
 *
 * MEASURED on 607 s of speech, sherpa-onnx diarizer, 8 performance cores:
 *
 *   1 thread  120.0 s      6 threads  45.2 s   <- fastest
 *   2 threads  72.6 s      7 threads  56.5 s
 *   4 threads  50.3 s      8 threads  66-122 s
 *                         10 threads 105.6 s
 *
 * MEASURED on 607 s of speech, whisper-vad-speech-segments, same machine:
 *
 *   1 thread  5.62 s      6 threads  2.17 s   <- fastest
 *   2 threads  3.38 s      7 threads  3.01 s
 *   4 threads  2.38 s      8 threads  3.88 s
 *
 * Both curves bottom out at 6 and climb on both sides of it. `base - 2` only
 * ever produced 6 on this one 8-performance-core machine by coincidence: on a
 * 16-core machine it does not bind at all (14), and on a 64-core Linux server
 * it would have handed an engine measured fastest at 6 a full 58 threads --
 * worse than the 4 both engines defaulted to before this feature existed, so
 * a regression rather than a missed optimisation. Below eight cores it bound
 * too hard, handing a 2-core machine one thread where two is measurably
 * faster (3.38 s against 5.62 s).
 *
 * 6 is the only optimum either engine has ever measured, measured
 * independently for both, by two different mechanisms (oversubscribed ONNX
 * sessions for the diarizer, thread-coordination overhead for the VAD).
 * Raising this number is a measurement, not a judgement: neither engine has
 * been profiled above eight threads on any machine but this one.
 */
const CAPPED_MAX_THREADS = 6;

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
  const cappedThreads = Math.min(threads, CAPPED_MAX_THREADS);

  return { threads, cappedThreads, gpu: options.gpu ?? true };
}
