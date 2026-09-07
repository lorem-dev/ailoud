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
  // Baseline for the log-flooding guard in report(): compared against the
  // PREVIOUS logged event, not the constructor's initial stage, so that
  // once the stage has moved away from "starting" the comparison does not
  // stay permanently true. See report()'s comment.
  private lastLoggedStage: string;
  private lastLoggedPercent: number;

  public constructor(private readonly options: JobReporterOptions) {
    this.current = options.initial;
    this.fraction = Math.min(1, Math.max(0, options.initial.percent / 100));
    this.now = options.now ?? (() => Date.now());
    this.throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
    this.startedAtMs = this.now();
    this.lastLoggedStage = options.initial.stage;
    this.lastLoggedPercent = options.initial.percent;
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
    this.fraction = next;
    const percent = Math.floor(next * 100);
    const etaSeconds = this.eta(next);
    // Drop any stale etaSeconds from the previous state before deciding
    // whether the new one applies -- a spread of {} (no ETA this time)
    // would otherwise leave the old value sitting in the document. See the
    // class comment and eta()'s own comment.
    const { etaSeconds: _previousEta, ...withoutEta } = this.current;
    this.current = {
      ...withoutEta,
      stage: event.stage,
      percent,
      ...(etaSeconds === undefined ? {} : { etaSeconds }),
    };
    // Compared against the previous LOGGED event, not the constructor's
    // fixed initial stage: whisper emits hundreds of lines an hour, and a
    // comparison against a value that never updates would log every one of
    // them once the stage had moved even once. Only a genuine stage change
    // or a genuine percentage change is worth a line.
    if (event.stage !== this.lastLoggedStage || percent !== this.lastLoggedPercent) {
      this.lastLoggedStage = event.stage;
      this.lastLoggedPercent = percent;
      this.options.log.append(`${new Date(this.now()).toISOString()} ${event.stage} ${percent}%`);
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
    // A terminal state has no remaining time by definition -- drop any ETA
    // rather than let the last one report() computed ride through into the
    // persisted 'done' document.
    const { etaSeconds: _previousEta, ...withoutEta } = this.current;
    this.current = {
      ...withoutEta,
      state: 'done',
      percent: 100,
      finishedAt: new Date(this.now()).toISOString(),
      result,
    };
    await this.writeNow();
  }

  public async fail(message: string): Promise<void> {
    // See finish(): a failed job has no remaining time either.
    const { etaSeconds: _previousEta, ...withoutEta } = this.current;
    this.current = {
      ...withoutEta,
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
   * Remaining seconds, or undefined.
   *
   * Undefined below ETA_FLOOR: at 2% the elapsed time says almost nothing
   * about the total, and a number that will be wrong by an order of
   * magnitude is worse than no number. Returning a plain `number | undefined`
   * rather than a spreadable `{ etaSeconds?: number }` is deliberate -- the
   * caller must decide explicitly whether the key is present or absent in
   * the next state, not rely on spreading `{}` to leave an old value alone.
   */
  private eta(fraction: number): number | undefined {
    if (fraction < ETA_FLOOR || fraction >= 1) return undefined;
    const elapsed = this.now() - this.startedAtMs;
    if (elapsed <= 0) return undefined;
    const remaining = (elapsed / fraction) * (1 - fraction);
    if (!Number.isFinite(remaining) || remaining < 0) return undefined;
    return Math.round(remaining / 1000);
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
