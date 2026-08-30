import { mkdir, readFile } from 'node:fs/promises';
import type {
  AudioTool,
  Clock,
  Diarizer,
  Fs,
  Ids,
  ManagedRecordingStore,
  SpeechSegmenter,
  TranscriptionProvider,
} from '@laud/core';
import { EnvironmentError } from '@laud/core';
import {
  FfmpegAudioTool,
  NodeFs,
  SherpaDiarizer,
  SystemClock,
  UlidIds,
  WhisperCppProvider,
  WhisperVadSegmenter,
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
  /**
   * Builds the VAD speech segmenter on demand, for the same reason
   * `createStt` does: `createContext` runs before every command, including
   * `doctor`, whose job is to report that the VAD model is missing without
   * dying while constructing the very thing it is reporting on.
   * `transcribe --multilingual` is the command that actually needs a
   * segmenter, so it is the one that pays for this call failing when the
   * model is missing.
   */
  createSegmenter(): SpeechSegmenter;
  /**
   * Builds the speaker diarizer on demand, for the same reason `createStt`
   * and `createSegmenter` do: `createContext` runs before every command,
   * including `doctor`, whose job is to report missing diarization models
   * without dying while constructing the very thing it is reporting on.
   * `transcribe --diarize` is the command that actually needs a diarizer,
   * so it is the one that pays for this call failing when a model is
   * missing.
   */
  createDiarizer(): Diarizer;
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
    createSegmenter(): SpeechSegmenter {
      const vadModel = config.stt.whisperCpp.vadModel;
      if (vadModel === null) {
        throw new EnvironmentError(
          `The whisper VAD model is not configured. Set "stt.whisperCpp.vadModel" in ` +
            `${paths.configFile} to the path of a VAD model file; run "laud doctor" for details.`,
        );
      }
      return new WhisperVadSegmenter({
        binary: config.stt.whisperCpp.vadBinary,
        vadModelPath: vadModel,
      });
    },
    createDiarizer(): Diarizer {
      const segmentationModel = config.stt.diarization.segmentationModel;
      if (segmentationModel === null) {
        throw new EnvironmentError(
          `The diarization segmentation model is not configured. Set ` +
            `"stt.diarization.segmentationModel" in ${paths.configFile} to the path of the ` +
            `sherpa-onnx pyannote segmentation model; run "laud doctor" for details.`,
        );
      }
      const embeddingModel = config.stt.diarization.embeddingModel;
      if (embeddingModel === null) {
        throw new EnvironmentError(
          `The diarization embedding model is not configured. Set ` +
            `"stt.diarization.embeddingModel" in ${paths.configFile} to the path of the ` +
            `sherpa-onnx speaker embedding model; run "laud doctor" for details.`,
        );
      }
      return new SherpaDiarizer({
        binary: config.stt.diarization.binary,
        segmentationModel,
        embeddingModel,
        threshold: config.stt.diarization.threshold,
        threads: config.stt.diarization.threads,
      });
    },
  };
}
