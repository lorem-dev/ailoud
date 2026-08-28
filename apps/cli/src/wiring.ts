import { mkdir, readFile } from 'node:fs/promises';
import type {
  AudioTool,
  Clock,
  Fs,
  Ids,
  ManagedRecordingStore,
  TranscriptionProvider,
} from '@laud/core';
import { EnvironmentError } from '@laud/core';
import {
  FfmpegAudioTool,
  NodeFs,
  SystemClock,
  UlidIds,
  WhisperCppProvider,
  openStore,
} from '@laud/providers';
import { parseConfig, resolvePaths } from './config.js';
import type { LaudConfig, LaudPaths } from './config.js';
import { createUi } from './ui/index.js';
import type { Ui } from './ui/index.js';

export interface CliContext {
  readonly paths: LaudPaths;
  readonly config: LaudConfig;
  readonly store: ManagedRecordingStore;
  readonly fs: Fs;
  readonly audio: AudioTool;
  readonly clock: Clock;
  readonly ids: Ids;
  /**
   * Raw, undecorated line output: commander's own help/version text, and
   * the two things that must never be decorated -- JSON (`ls --json`,
   * `show --format json`) and transcript data (`show`'s text/srt/vtt).
   * Everything else a command reports goes through `ui` instead.
   */
  readonly write: (line: string) => void;
  readonly ui: Ui;
  /**
   * Builds the transcription provider on demand instead of at context
   * construction. `createContext` runs before every command, including
   * `doctor`, whose entire purpose is to report that the model is not
   * configured. If the provider were built eagerly here, `doctor` would
   * throw before printing anything on exactly the fresh machine where a
   * user runs it first. `transcribe` is the command that actually needs a
   * provider, so it is the one that pays for this call failing when the
   * model is missing.
   */
  createStt(): TranscriptionProvider;
}

async function readConfigFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null; // no config file is the normal first run, not an error
  }
}

export async function createContext(
  env: Record<string, string | undefined>,
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<CliContext> {
  const paths = resolvePaths(env);
  const raw = await readConfigFile(paths.configFile);
  const config = parseConfig(raw);
  await mkdir(paths.mediaRoot, { recursive: true });
  return {
    paths,
    config,
    store: openStore(paths.dbFile),
    fs: new NodeFs(),
    audio: new FfmpegAudioTool(),
    clock: new SystemClock(),
    ids: new UlidIds(),
    write,
    ui: createUi(write),
    createStt(): TranscriptionProvider {
      const model = config.stt.whisperCpp.model;
      if (model === null) {
        throw new EnvironmentError(
          `The whisper.cpp model is not configured. Set "stt.whisperCpp.model" in ` +
            `${paths.configFile} to the path of a model file; run "laud doctor" for details.`,
        );
      }
      return new WhisperCppProvider({ binary: config.stt.whisperCpp.binary, modelPath: model });
    },
  };
}
