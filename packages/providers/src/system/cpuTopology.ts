import { availableParallelism } from 'node:os';
import type { CpuTopology } from '@ailoud/core';
import { run as defaultRunner } from '../process/run.js';

/**
 * Short, unlike every other timeout in this project: `sysctl -n` reads one
 * kernel value and returns. Anything slower than this is a machine in trouble,
 * and waiting on it would delay the start of every transcription.
 */
const SYSCTL_TIMEOUT_MS = 5_000;

/**
 * The count of performance cores, or null when the answer is not usable.
 *
 * `logical` is the sanity bound: a split larger than the total is a value
 * this code does not understand, and guessing at it would produce a ceiling
 * higher than the machine has.
 */
export function parsePerformanceCores(stdout: string, logical: number): number | null {
  const trimmed = stdout.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isInteger(value)) return null;
  if (value < 1 || value > logical) return null;
  return value;
}

interface TopologyDeps {
  readonly platform: NodeJS.Platform;
  readonly logical: () => number;
  readonly run: typeof defaultRunner;
}

let memo: Promise<CpuTopology> | null = null;

async function read(deps: TopologyDeps): Promise<CpuTopology> {
  const logical = Math.max(1, Math.round(deps.logical()));

  // darwin only, on purpose. Linux reports nothing comparable that is
  // reliable across kernels and vendors -- `cpu_capacity` is absent on most
  // x86 kernels and `cpuinfo_max_freq` reflects boost state, not core class --
  // and a wrong split is worse than no split: it would cap the ceiling below
  // what the machine can actually do, on every run, invisibly.
  if (deps.platform !== 'darwin') return { logical, performance: null };

  try {
    // An argument array, never a shell string.
    const result = await deps.run('sysctl', ['-n', 'hw.perflevel0.logicalcpu'], {
      timeoutMs: SYSCTL_TIMEOUT_MS,
    });
    if (result.code !== 0) return { logical, performance: null };
    return { logical, performance: parsePerformanceCores(result.stdout, logical) };
  } catch {
    // `run` turns a missing binary into an EnvironmentError, and a timeout
    // into a rejection. Neither is a reason to fail a transcription: the
    // logical count is a perfectly serviceable answer.
    return { logical, performance: null };
  }
}

/**
 * What this machine offers. Memoised: the topology cannot change while the
 * process runs, and this sits in front of every transcription.
 *
 * `deps` is for tests only. Production passes nothing.
 */
export function cpuTopology(deps?: Partial<TopologyDeps>): Promise<CpuTopology> {
  if (deps !== undefined) {
    return read({
      platform: deps.platform ?? process.platform,
      logical: deps.logical ?? availableParallelism,
      run: deps.run ?? defaultRunner,
    });
  }
  memo ??= read({
    platform: process.platform,
    logical: availableParallelism,
    run: defaultRunner,
  });
  return memo;
}
