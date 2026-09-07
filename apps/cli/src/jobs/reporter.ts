import { clampMonotonic } from '@ailoud/core';
import type { Fs, OnProgress, ProgressEvent } from '@ailoud/core';
import type { JobLog } from './log.js';
import { writeJobState } from './state.js';
import type { JobState } from './state.js';

/** How often the state file is rewritten while work is in flight. */
const DEFAULT_THROTTLE_MS = 2000;

/** Below this, an ETA is noise presented as a number. */
const ETA_FLOOR = 0.05;

export interface JobReporterOptions {
  readonly fs: Fs;
  readonly jobsDir: string;
  readonly initial: JobState;
  readonly log: JobLog;
  readonly now?: () => number;
  readonly throttleMs?: number;
}

/**
 * Turns the pipeline's progress events into the job's state file.
 *
 * Three properties, in the order they matter:
 *
 * 1. **It cannot throw.** `report` is called from inside a transcription. It
 *    updates memory, may start a write, and swallows everything -- including
 *    the rejection of a write nobody is awaiting, which would otherwise
 *    surface as an unhandled rejection and take the process down.
 * 2. **The percentage never falls.** Through clampMonotonic, so a stage that
 *    recomputes its estimate cannot walk the bar backwards.
 * 3. **Writes are throttled, terminal writes are not.** whisper emits
 *    hundreds of progress lines an hour and polls arrive minutes apart, so
 *    an unthrottled writer rewrites the file tens of thousands of times for
 *    no reader. `finish` and `fail` always write.
 */
export class JobReporter {
  private current: JobState;
  private fraction: number;
  private lastWriteAt = Number.NEGATIVE_INFINITY;
  private queue: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly throttleMs: number;
  private readonly startedAtMs: number;

  public constructor(private readonly options: JobReporterOptions) {
    this.current = options.initial;
    this.fraction = Math.min(1, Math.max(0, options.initial.percent / 100));
    this.now = options.now ?? (() => Date.now());
    this.throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
    this.startedAtMs = this.now();
  }

  /** A sink to hand straight to a pipeline's `onProgress`. */
  public get onProgress(): OnProgress {
    return (event) => {
      this.report(event);
    };
  }

  public report(event: ProgressEvent): void {
    const next =
      event.fraction === undefined ? this.fraction : clampMonotonic(this.fraction, event.fraction);
    const moved = next !== this.fraction;
    this.fraction = next;
    this.current = {
      ...this.current,
      stage: event.stage,
      percent: Math.floor(next * 100),
      ...this.eta(next),
    };
    if (moved || event.stage !== this.options.initial.stage) {
      this.options.log.append(
        `${new Date(this.now()).toISOString()} ${event.stage} ${Math.floor(next * 100)}%`,
      );
    }
    if (this.now() - this.lastWriteAt >= this.throttleMs) this.enqueueWrite();
  }

  /** How many recordings of the batch are finished. Cosmetic, and cheap. */
  public advance(recordingsDone: number): void {
    this.current = {
      ...this.current,
      recordings: { ...this.current.recordings, done: recordingsDone },
    };
    this.enqueueWrite();
  }

  public async finish(result: unknown): Promise<void> {
    this.current = {
      ...this.current,
      state: 'done',
      percent: 100,
      finishedAt: new Date(this.now()).toISOString(),
      result,
    };
    await this.writeNow();
  }

  public async fail(message: string): Promise<void> {
    this.current = {
      ...this.current,
      state: 'failed',
      finishedAt: new Date(this.now()).toISOString(),
      error: message,
    };
    this.options.log.append(`${new Date(this.now()).toISOString()} failed: ${message}`);
    await this.writeNow();
  }

  /** Waits for whatever writes are queued. Resolves even when they failed. */
  public async flush(): Promise<void> {
    this.enqueueWrite();
    await this.queue;
    await this.options.log.flush();
  }

  /**
   * Remaining seconds, or nothing.
   *
   * Omitted below ETA_FLOOR: at 2% the elapsed time says almost nothing
   * about the total, and a number that will be wrong by an order of
   * magnitude is worse than no number.
   */
  private eta(fraction: number): { etaSeconds?: number } {
    if (fraction < ETA_FLOOR || fraction >= 1) return {};
    const elapsed = this.now() - this.startedAtMs;
    if (elapsed <= 0) return {};
    const remaining = (elapsed / fraction) * (1 - fraction);
    if (!Number.isFinite(remaining) || remaining < 0) return {};
    return { etaSeconds: Math.round(remaining / 1000) };
  }

  /**
   * Starts a write nobody awaits.
   *
   * The `.catch` sits on the chain itself -- `this.queue = this.queue.then(...).catch(...)`
   * -- rather than being attached separately to the promise this method
   * hands back to a caller (it hands back nothing). That placement is what
   * keeps a failed write from becoming an unhandled rejection: `this.queue`
   * always settles fulfilled, because every rejection that could reach it is
   * caught before it is assigned back to the field. A later `.then` chained
   * from `flush` or `writeNow` therefore never observes a rejected promise.
   */
  private enqueueWrite(): void {
    this.lastWriteAt = this.now();
    const snapshot = this.current;
    this.queue = this.queue
      .then(() => writeJobState(this.options.fs, this.options.jobsDir, snapshot))
      .catch(() => {
        // A state file that cannot be written costs the percentage. It does
        // not cost the transcription, and it must not reject into a caller
        // that is not awaiting anything. See the class comment.
      });
  }

  private async writeNow(): Promise<void> {
    this.enqueueWrite();
    await this.queue;
    await this.options.log.flush();
  }
}
