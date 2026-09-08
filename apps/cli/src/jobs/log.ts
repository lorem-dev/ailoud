import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * The job's append-only trail: stage transitions, warnings, and the reason a
 * job failed. It does NOT carry the engine's own stderr -- nothing in this
 * codebase plumbs that through yet, and `error` on the state document already
 * carries the failure message a caller would want.
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
  private dirReady: Promise<void> | undefined;

  public constructor(private readonly path: string) {}

  /**
   * Creates the log's directory, once per instance.
   *
   * mkdir is idempotent but not free, and whisper alone writes on the order
   * of 104 stderr lines per run -- re-issuing a recursive mkdir before every
   * one of them is that many redundant syscalls for a directory that only
   * ever needs creating once. The promise is memoised, including a
   * rejection: if the directory genuinely cannot be created, later appends
   * find that out from the cached rejection rather than retrying the same
   * doomed mkdir. That rejection is always awaited from inside `append`'s
   * own try, in the same call that creates it, so it can never surface as
   * an unhandled rejection -- the same reasoning that governs `append`
   * itself.
   */
  private ensureDir(): Promise<void> {
    this.dirReady ??= mkdir(dirname(this.path), { recursive: true }).then(() => undefined);
    return this.dirReady;
  }

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
        await this.ensureDir();
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
