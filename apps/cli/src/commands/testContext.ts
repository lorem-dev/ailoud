import type { TranscriptionProvider } from '@laud/core';
import {
  FakeAudioTool,
  FakeClock,
  FakeIds,
  FakeStt,
  InMemoryStore,
  MemFs,
} from '@laud/core/testing';
import { buildProgram } from '../program.js';
import type { CliContext } from '../wiring.js';

/** The audio fixture every helper-built recording is imported from. */
export const FIXTURE_PATH = '/in/a.mp3';

/**
 * Builds a CliContext over the in-memory fakes, with a `lines` sink that
 * captures everything passed to the context's `out` callback. This is the
 * starting point for every command test in this package -- and, per Task
 * 14's brief, for Task 15's as well, so its shape is depended on beyond
 * this task.
 */
export function context(): CliContext & { lines: string[]; sttInstances: FakeStt[] } {
  const lines: string[] = [];
  const sttInstances: FakeStt[] = [];
  return {
    lines,
    sttInstances,
    paths: { configFile: '/c', dataDir: '/d', dbFile: '/d/laud.db', mediaRoot: '/d/media' },
    config: { stt: { provider: 'whisper-cpp', whisperCpp: { binary: 'w', model: '/m.bin' } } },
    store: new InMemoryStore(),
    fs: new MemFs({ [FIXTURE_PATH]: 'AUDIO' }),
    audio: new FakeAudioTool(3200),
    clock: new FakeClock(),
    ids: new FakeIds(),
    out: (line: string) => {
      lines.push(line);
    },
    createStt: (): TranscriptionProvider => {
      const stt = new FakeStt({
        language: 'ru',
        model: 'base.bin',
        segments: [{ startMs: 0, endMs: 1500, text: 'Privet.' }],
      });
      sttInstances.push(stt);
      return stt;
    },
  };
}

export interface ContextWithTranscriptOptions {
  /**
   * Skip importing the fixture recording, leaving the library empty. Set
   * this to exercise an empty-library scenario.
   */
  readonly skipImport?: boolean;
  /**
   * Import the fixture recording but stop before transcribing it, leaving
   * a recording with no transcript.
   */
  readonly skipTranscribe?: boolean;
  /**
   * Empty out `lines` once setup is done, so a test can assert on its own
   * command's output without slicing off the setup lines. Left as-is by
   * default so existing callers keep seeing the setup output.
   */
  readonly clearLines?: boolean;
}

/**
 * A context that has already run `laud import` (and, by default, `laud
 * transcribe`) against the fixture recording, driven through the real
 * program so the fixtures stay in sync with whatever those commands
 * actually do. `skipImport` yields an empty library; `skipTranscribe`
 * yields a recording with no transcript.
 */
export async function contextWithTranscript(
  opts: ContextWithTranscriptOptions = {},
): Promise<CliContext & { lines: string[]; sttInstances: FakeStt[] }> {
  const ctx = context();
  const done = (): CliContext & { lines: string[]; sttInstances: FakeStt[] } => {
    if (opts.clearLines === true) ctx.lines.length = 0;
    return ctx;
  };
  if (opts.skipImport === true) return done();
  await buildProgram(ctx).parseAsync(['node', 'laud', 'import', FIXTURE_PATH]);
  if (opts.skipTranscribe === true) return done();
  await buildProgram(ctx).parseAsync(['node', 'laud', 'transcribe']);
  return done();
}
