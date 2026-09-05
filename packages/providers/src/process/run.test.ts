import { describe, expect, it } from 'vitest';
import { EnvironmentError, FailureError } from '@ailoud/core';
import { run, runInteractive } from './run.js';

describe('run', () => {
  it('captures stdout and the exit code', async () => {
    const result = await run('node', ['-e', 'process.stdout.write("hi")']);
    expect(result).toEqual({ code: 0, stdout: 'hi', stderr: '' });
  });

  it('captures a non-zero exit without throwing', async () => {
    const result = await run('node', ['-e', 'process.exit(3)']);
    expect(result.code).toBe(3);
  });

  it('reports a missing binary as an EnvironmentError', async () => {
    await expect(run('ailoud-no-such-binary', [])).rejects.toThrow(EnvironmentError);
    await expect(run('ailoud-no-such-binary', [])).rejects.toThrow(/not found/);
  });

  it('kills a process that outlives its timeout, as a FailureError not an EnvironmentError', async () => {
    // A timeout means the binary was found and ran, it just did not finish
    // in time -- a failure of this run, not a broken environment doctor
    // could fix, so it is exit 1, not exit 3.
    await expect(
      run('node', ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200 }),
    ).rejects.toThrow(FailureError);
    await expect(
      run('node', ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200 }),
    ).rejects.toThrow(/timed out/);
  });

  it('reports a signal death as 128 + signal number, not the same sentinel as a real failure', async () => {
    // Self-terminate via a real signal (as an external kill or Ctrl-C
    // would) instead of process.exit, so close() actually receives
    // code === null and a signal name, the case exitCodeForClose exists
    // to handle distinctly from a genuine non-zero exit.
    const result = await run('node', ['-e', 'process.kill(process.pid, "SIGTERM")']);
    expect(result.code).toBe(128 + 15);
  });
});

describe('runInteractive', () => {
  it('resolves with the exit code on success', async () => {
    expect(await runInteractive('node', ['-e', 'process.exit(0)'])).toBe(0);
  });

  it('resolves with the exit code rather than throwing on failure', async () => {
    // A failed install is a reportable outcome for the provisioning plan,
    // not an exception -- one failed action must not abandon the rest.
    expect(await runInteractive('node', ['-e', 'process.exit(3)'])).toBe(3);
  });

  it('reports a missing binary as an EnvironmentError', async () => {
    await expect(runInteractive('ailoud-no-such-binary', [])).rejects.toThrow(EnvironmentError);
  });

  it('reports a signal death (e.g. Ctrl-C at a sudo password prompt) as 128 + signal number', async () => {
    // Distinguishing "cancelled" from "failed" is the whole point of this
    // fix: both used to collapse to a fixed sentinel that a genuine
    // apt-get failure could also produce.
    const code = await runInteractive('node', ['-e', 'process.kill(process.pid, "SIGTERM")']);
    expect(code).toBe(128 + 15);
  });
});
