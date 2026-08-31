import type { Diarizer, SpeechSegmenter, Summarizer, TranscriptionProvider } from '@laud/core';
import { parseConfig } from '../config.js';
import {
  FakeAudioTool,
  FakeClock,
  FakeDiarizer,
  FakeIds,
  FakeSegmenter,
  FakeStt,
  InMemoryStore,
  MemFs,
} from '@laud/core/testing';
import { buildProgram } from '../program.js';
import type { CliContext } from '../wiring.js';
import { PlainUi } from '../ui/plain.js';

/** The audio fixture every helper-built recording is imported from. */
export const FIXTURE_PATH = '/in/a.mp3';

/**
 * Builds a CliContext over the in-memory fakes, with a `lines` sink that
 * captures everything passed to the context's `out` callback. This is the
 * starting point for every command test in this package, so its shape is
 * depended on well beyond whichever single test happens to be reading it.
 */
export function context(): CliContext & {
  lines: string[];
  sttInstances: FakeStt[];
  segmenterInstances: FakeSegmenter[];
  diarizerInstances: FakeDiarizer[];
  summarizerPrompts: string[];
} {
  const lines: string[] = [];
  const sttInstances: FakeStt[] = [];
  const segmenterInstances: FakeSegmenter[] = [];
  const diarizerInstances: FakeDiarizer[] = [];
  const summarizerPrompts: string[] = [];
  const write = (line: string): void => {
    lines.push(line);
  };
  return {
    lines,
    sttInstances,
    segmenterInstances,
    diarizerInstances,
    summarizerPrompts,
    paths: { configFile: '/c', dataDir: '/d', dbFile: '/d/laud.db', mediaRoot: '/d/media' },
    config: {
      stt: {
        provider: 'whisper-cpp',
        whisperCpp: { binary: 'w', model: '/m.bin', vadBinary: 'wv', vadModel: '/vad.bin' },
        // Left unconfigured (schema defaults): most tests in this package
        // never touch diarization, and the few that do (doctor/setup specs)
        // override this block with their own fixture paths.
        diarization: {
          binary: 'sherpa-onnx-offline-speaker-diarization',
          segmentationModel: null,
          embeddingModel: null,
          threshold: 0.6,
          threads: 4,
        },
      },
      llm: parseConfig(null).llm,
    },
    store: new InMemoryStore(),
    fs: new MemFs({ [FIXTURE_PATH]: 'AUDIO' }),
    audio: new FakeAudioTool(3200),
    clock: new FakeClock(),
    ids: new FakeIds(),
    write,
    // PlainUi, not PrettyUi: every command test in this package captures
    // output through `lines` and asserts on exact strings, the same
    // property the end-to-end suite leans on when it runs through a pipe.
    ui: new PlainUi(write),
    createStt: (): TranscriptionProvider => {
      const stt = new FakeStt({
        language: 'ru',
        model: 'base.bin',
        segments: [{ startMs: 0, endMs: 1500, text: 'Privet.' }],
      });
      sttInstances.push(stt);
      return stt;
    },
    createSegmenter: (): SpeechSegmenter => {
      const segmenter = new FakeSegmenter([{ startMs: 0, endMs: 1500 }]);
      segmenterInstances.push(segmenter);
      return segmenter;
    },
    createDiarizer: (): Diarizer => {
      const diarizer = new FakeDiarizer([{ startMs: 0, endMs: 1500, speaker: 'speaker_00' }]);
      diarizerInstances.push(diarizer);
      return diarizer;
    },
    createSummarizer: (): Summarizer => {
      // Echoes back what it was asked, so a test can assert on the prompt the
      // pipeline built without needing a model. Specs that care about the
      // summary itself override this.
      const summarizer: Summarizer = {
        name: 'fake',
        model: 'fake-model',
        contextTokens: 8192,
        complete: async (prompt: string) => {
          summarizerPrompts.push(prompt);
          return 'a summary';
        },
      };
      return summarizer;
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
): Promise<CliContext & { lines: string[]; sttInstances: FakeStt[]; summarizerPrompts: string[] }> {
  const ctx = context();
  const done = (): CliContext & {
    lines: string[];
    sttInstances: FakeStt[];
    summarizerPrompts: string[];
  } => {
    if (opts.clearLines === true) ctx.lines.length = 0;
    return ctx;
  };
  if (opts.skipImport === true) return done();
  await buildProgram(ctx).parseAsync(['node', 'laud', 'import', FIXTURE_PATH]);
  if (opts.skipTranscribe === true) return done();
  await buildProgram(ctx).parseAsync(['node', 'laud', 'transcribe']);
  return done();
}
