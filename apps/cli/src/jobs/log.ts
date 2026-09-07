import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * The job's append-only trail: stage transitions, warnings, and whisper's
 * stderr.
 *
 * Appends are queued rather than awaited by the caller, because the caller
 * is a progress sink in the middle of a transcription and must not be given
 * anything to await or to catch. `flush` exists for the end of the run and
 * for tests.
 *
 * Takes only a path, not an `Fs`. `Fs` has no append operation, and adding
 * one to the port for a log file would widen an interface five
 * implementations share for the sake of one caller. This uses node:fs
 * directly, which `apps/cli` is allowed to do -- the no-I/O rule binds
 * `packages/core` only.
 */
export class JobLog {
  private queue: Promise<void> = Promise.resolve();

  public constructor(private readonly path: string) {}

  /**
   * Queues one line. Never throws, never returns anything to await.
   *
   * A log that cannot be written costs the log. It does not cost the
   * transcription, and it does not get to reject somewhere nobody is
   * listening -- hence the catch on the chain rather than on the caller.
   */
  public append(line: string): void {
    this.queue = this.queue
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        await appendFile(this.path, `${line}\n`, 'utf8');
      })
      .catch(() => {
        // See the doc comment. Deliberately empty.
      });
  }

  /** Waits for every queued append. Resolves even when they all failed. */
  public async flush(): Promise<void> {
    await this.queue;
  }
}
