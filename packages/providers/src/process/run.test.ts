import { describe, expect, it } from 'vitest';
import { EnvironmentError, FailureError } from '@laud/core';
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
    await expect(run('laud-no-such-binary', [])).rejects.toThrow(EnvironmentError);
    await expect(run('laud-no-such-binary', [])).rejects.toThrow(/not found/);
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
    await expect(runInteractive('laud-no-such-binary', [])).rejects.toThrow(EnvironmentError);
  });
});
