import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { EnvironmentError, FailureError } from '@ailoud/core';

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly timeoutMs?: number;
  /**
   * Written to the child's stdin, which is then closed.
   *
   * The reason this exists: a prompt carrying a transcript does not fit in an
   * argument. ARG_MAX is about a megabyte on macOS, less once the environment
   * is counted, and a few hours of speech passes it -- the spawn then fails
   * with E2BIG, which is a failure the user can do nothing about.
   */
  readonly stdin?: string;
  /**
   * Called once per complete line of stderr, as it arrives, without the
   * trailing newline. A final fragment that never got a newline is delivered
   * on close.
   *
   * Additive: `stderr` in the result is still the whole stream, byte for
   * byte, whether or not this is passed. The buffering was not replaced by
   * this, it was left alone -- every transcription in the tool goes through
   * this function, and a progress feature is not worth risking it.
   *
   * Never lets a sink's exception escape. A caller watching for progress
   * must not be able to fail the command it is watching.
   */
  readonly onStderrLine?: (line: string) => void;
}

const DEFAULT_TIMEOUT_MS = 30 * 60_000;

/**
 * `code` is null exactly when the child died from a signal rather than
 * exiting on its own -- e.g. a user pressing Ctrl-C at a sudo password
 * prompt. Collapsing that to a fixed sentinel like -1 or 1 makes "you
 * cancelled" indistinguishable from "the command genuinely failed with
 * that exit code", which is the wrong thing to report to someone trying to
 * understand what just happened. 128 + signal number is the same mapping
 * shells use (`$?` after a Ctrl-C'd command is 130, i.e. 128 + SIGINT's 2),
 * so callers get a value that is both unambiguous and already familiar.
 */
function exitCodeForClose(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal !== null) return 128 + (constants.signals[signal] ?? 0);
  return -1;
}

export function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    // shell: false is the default and must stay that way: paths reaching this
    // function come from user input, and a shell would interpret them.
    const child = spawn(command, [...args], { shell: false });

    if (options.stdin !== undefined) {
      // EPIPE if the child exits before reading it all -- which is a normal
      // way for a child to behave, not an error worth failing the run over.
      child.stdin.on('error', () => {});
      child.stdin.end(options.stdin, 'utf8');
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    // Held between chunks: a line is routinely split across two 'data'
    // events, and splitting each chunk on its own loses whatever straddled
    // the boundary. Measured on whisper-cli, which emits ~104 stderr lines
    // per run.
    let pending = '';
    const emit = (line: string): void => {
      try {
        options.onStderrLine?.(line);
      } catch {
        // A progress sink is an observer. It does not get to fail the run.
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr += text;
      if (options.onStderrLine === undefined) return;
      pending += text;
      const parts = pending.split('\n');
      pending = parts.pop() ?? '';
      for (const part of parts) emit(part);
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === 'ENOENT') {
        reject(
          new EnvironmentError(
            `${command} was not found on PATH. Install it, or set its path in the ailoud config; run "ailoud doctor" for details.`,
          ),
        );
        return;
      }
      reject(error);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (pending !== '') {
        emit(pending);
        pending = '';
      }
      if (timedOut) {
        // A timeout is not "the machine is not set up": the binary was
        // found and started fine, it just did not finish in the time this
        // one call allowed. That is a failure of this particular run, not
        // of the environment, so it is a FailureError (exit 1) rather than
        // an EnvironmentError (exit 3) -- there is no "fix" for doctor to
        // report, only a run that needs to be retried, given more time, or
        // investigated as its own problem.
        reject(new FailureError(`${command} timed out after ${timeoutMs} ms and was killed`));
        return;
      }
      resolve({ code: exitCodeForClose(code, signal), stdout, stderr });
    });
  });
}

/**
 * Runs a command with the parent's stdio, so anything it prints -- including
 * a sudo password prompt -- reaches the real terminal. run() above buffers
 * output instead, which is exactly wrong here: the prompt would vanish into
 * a buffer and the user would stare at a hung terminal.
 *
 * Returns the exit code rather than throwing on a non-zero one: a failed
 * install is a reportable outcome for provisioning, not an exception --
 * one failed action must not abandon the rest of the plan.
 *
 * Deliberately has no timeout, unlike run(): a hard bound would kill a
 * legitimate wait at a password prompt. The consequence is that with
 * nothing real attached to stdin (no TTY), this can wait indefinitely, so
 * callers must not invoke it non-interactively -- a later task enforces
 * that at the call site.
 */
export function runInteractive(command: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    // shell: false for the same reason as run() above: these paths come
    // from user input, and a shell would interpret them.
    const child = spawn(command, [...args], { shell: false, stdio: 'inherit' });

    child.on('error', (error) => {
      reject(
        new EnvironmentError(
          `could not run "${command}": ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    });

    // See exitCodeForClose above run(): the same code-vs-signal ambiguity
    // applies here, and matters more, since Ctrl-C at a sudo prompt is the
    // expected way a user cancels this specific function.
    child.on('close', (code, signal) => resolve(exitCodeForClose(code, signal)));
  });
}
