import { spawn } from 'node:child_process';
import { EnvironmentError, FailureError } from '@laud/core';

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30 * 60_000;

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
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === 'ENOENT') {
        reject(
          new EnvironmentError(
            `${command} was not found on PATH. Install it, or set its path in the laud config; run "laud doctor" for details.`,
          ),
        );
        return;
      }
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
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
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}
