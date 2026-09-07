import { describe, expect, it, vi } from 'vitest';
import { cpuTopology, parsePerformanceCores } from './cpuTopology.js';

describe('parsePerformanceCores', () => {
  it('reads the count sysctl prints', () => {
    // Measured on an M1 Pro: `sysctl -n hw.perflevel0.logicalcpu` prints "8".
    expect(parsePerformanceCores('8\n', 10)).toBe(8);
  });

  it.each([
    ['', 'empty output'],
    ['not a number\n', 'unparseable output'],
    ['0\n', 'a count below one'],
    ['-3\n', 'a negative count'],
    ['12\n', 'a count above the logical total'],
    ['3.5\n', 'a fractional count'],
  ])('answers null for %s (%s)', (stdout) => {
    // Every one of these means "the split is unknown", and unknown must fall
    // back to the logical count rather than produce a wrong ceiling.
    expect(parsePerformanceCores(stdout, 10)).toBeNull();
  });
});

describe('cpuTopology', () => {
  it('reads the performance split on darwin', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '8\n', stderr: '' });
    const topology = await cpuTopology({ platform: 'darwin', logical: () => 10, run });
    expect(topology).toEqual({ logical: 10, performance: 8 });
    const [command, args, options] = run.mock.calls[0]!;
    expect(command).toBe('sysctl');
    // An argument array, never a shell string. AGENTS.md, Security Notes.
    expect(args).toEqual(['-n', 'hw.perflevel0.logicalcpu']);
    // Every subprocess call carries a timeout.
    expect(options.timeoutMs).toBeGreaterThan(0);
  });

  it('does not run sysctl at all off darwin', async () => {
    const run = vi.fn();
    const topology = await cpuTopology({ platform: 'linux', logical: () => 16, run });
    expect(topology).toEqual({ logical: 16, performance: null });
    expect(run).not.toHaveBeenCalled();
  });

  it('answers a null split when sysctl exits non-zero', async () => {
    // Intel macOS has no perflevel keys, so this is the normal path there.
    const run = vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'unknown oid' });
    const topology = await cpuTopology({ platform: 'darwin', logical: () => 8, run });
    expect(topology).toEqual({ logical: 8, performance: null });
  });

  it('answers a null split when sysctl throws, without throwing itself', async () => {
    // A resource hint may never be the thing that fails a transcription.
    const run = vi.fn().mockRejectedValue(new Error('spawn ENOENT'));
    await expect(cpuTopology({ platform: 'darwin', logical: () => 8, run })).resolves.toEqual({
      logical: 8,
      performance: null,
    });
  });

  it('floors the logical count at one', async () => {
    const run = vi.fn();
    const topology = await cpuTopology({ platform: 'linux', logical: () => 0, run });
    expect(topology.logical).toBe(1);
  });
});
