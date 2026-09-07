import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Fs } from '@ailoud/core';

export type JobKind = 'transcribe' | 'summarize';
export type JobStateName = 'running' | 'done' | 'failed';

/**
 * Everything a poller needs, and nothing more.
 *
 * Small on purpose. This document is what an agent reads every few minutes,
 * so the detail -- stage transitions and warnings as the job runs -- goes to
 * `log` and is fetched by path rather than inlined here. Same trade
 * `get_transcript` makes with a transcript. The log does not carry the
 * engine's own stderr; `error` below already carries the failure message.
 */
export interface JobState {
  readonly id: string;
  readonly kind: JobKind;
  readonly state: JobStateName;
  /** Integer 0..100, monotonic. See clampMonotonic in @ailoud/core. */
  readonly percent: number;
  readonly stage: string;
  /** Omitted below 5%, where it would be noise presented as a number. */
  readonly etaSeconds?: number;
  /** Whose process this is, so a poller can tell "died" from "working". */
  readonly pid: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly recordings: { readonly total: number; readonly done: number };
  /** What the caller declared before starting. Recorded, not acted on. */
  readonly declared: {
    readonly speakers: number | 'unknown';
    readonly languages: readonly string[];
  } | null;
  readonly log: string;
  /** Set once, on success. Never the summary body -- see the design. */
  readonly result: unknown;
  /** One message on failure. No stack: nobody polls for a stack. */
  readonly error: string | null;
}

export function jobStatePath(jobsDir: string, id: string): string {
  return join(jobsDir, `${id}.json`);
}

export function jobLogPath(jobsDir: string, id: string): string {
  return join(jobsDir, `${id}.log`);
}

/**
 * Replaces the state file atomically.
 *
 * Written beside the target and renamed over it, through `Fs.rename`, whose
 * own doc comment exists for exactly this: "callers write a temporary file
 * beside the real one and rename it over the top, so a reader never sees
 * half a file". Without it a poll eventually parses half a document and an
 * agent reports a crash that never happened.
 */
export async function writeJobState(fs: Fs, jobsDir: string, state: JobState): Promise<void> {
  await fs.ensureDir(jobsDir);
  const target = jobStatePath(jobsDir, state.id);
  // Randomised per call, same pattern as writeRegistry in projects.ts, so
  // two writers for the same job id never share -- and corrupt -- one
  // temporary file.
  const scratch = `${target}.${randomUUID()}.writing`;
  await fs.writeTextFile(scratch, `${JSON.stringify(state, null, 2)}\n`);
  await fs.rename(scratch, target);
}

/**
 * Reads a state file, or null.
 *
 * Null covers three cases a caller cannot usefully distinguish: no such job,
 * a file that is not readable, and a file that is not valid JSON. The last
 * one is a job that died between creating the file and writing it, and it
 * must not surface as a parse error about a file the user never heard of --
 * the same reasoning `readHolder` in exclusiveLock.ts gives.
 */
export async function readJobState(fs: Fs, jobsDir: string, id: string): Promise<JobState | null> {
  const path = jobStatePath(jobsDir, id);
  if (!(await fs.exists(path))) return null;
  try {
    const parsed: unknown = JSON.parse(await fs.readTextFile(path));
    if (typeof parsed !== 'object' || parsed === null) return null;
    // Safe: the shape on disk is only ever written by writeJobState above,
    // so a parsed object is a JobState. If it is not -- a manually edited
    // file, a future format change -- the caller is a poller that treats
    // this as "still running" at worst, not code that trusts the fields
    // for anything unattended.
    return parsed as JobState;
  } catch {
    return null;
  }
}
