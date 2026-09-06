import { mkdir, readFile } from 'node:fs/promises';
import type {
  AudioTool,
  Clock,
  Diarizer,
  Fs,
  Ids,
  ManagedRecordingStore,
  SpeechSegmenter,
  Summarizer,
  TranscriptionProvider,
  VersionSource,
} from '@ailoud/core';
import { existsSync, statSync } from 'node:fs';
import { EnvironmentError, isHostedLlm } from '@ailoud/core';
import {
  AnthropicSummarizer,
  ClaudeCliSummarizer,
  DEFAULT_REGISTRY,
  DEFAULT_TIMEOUT_MS,
  FfmpegAudioTool,
  LlamaCppSummarizer,
  NodeFs,
  NpmRegistry,
  OpenAiCompatibleSummarizer,
  SherpaDiarizer,
  SystemClock,
  UlidIds,
  WhisperCppProvider,
  WhisperVadSegmenter,
  openStore,
} from '@ailoud/providers';
import { PROJECT_DIR, parseConfig, resolvePaths } from './config.js';
import type { RegistryTransport } from '@ailoud/providers';
import type { AiloudConfig, AiloudPaths } from './config.js';
import { createUi } from './ui/index.js';
import type { Ui } from './ui/index.js';
import { apiKeyFrom } from './apiKey.js';
import { rememberProject } from './projects.js';

/**
 * Where `ailoud self check` looks for newer versions, and how long it waits.
 * Not read from AiloudConfig: the schema's `update.check` key is only
 * whether to look, never where -- there is one npm registry this project
 * publishes to, and no user has a reason to point ailoud at another one.
 */
const UPDATE_REGISTRY = DEFAULT_REGISTRY;
const UPDATE_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;

/**
 * Stubs the npm registry answer with a JSON fixture, when `AILOUD_PACKUMENTS`
 * names one, instead of a real network call.
 *
 * Same environment variable and the same fixture shape --
 * `{ "<package>": <packument> }` -- that `scripts/retire-prereleases.mjs`
 * reads for the identical reason: a file an end-to-end test can point at,
 * never a server a test could leave open. A thrown test there once skipped
 * the server's own `close()`, and the leaked handle hung the whole suite
 * with no failing test to point at, because a per-test timeout does not
 * apply to a handle nobody closed. This reads a file instead, on every call,
 * so there is never a handle to leak.
 */
function packumentFixtureTransport(fixturePath: string): RegistryTransport {
  // Announced on stderr, every run, deliberately. This hook ships INSIDE the
  // binary -- unlike the identical variable in scripts/retire-prereleases.mjs,
  // which only maintainers run -- so it can substitute where `self check` and
  // `self update` get their version facts. Nobody can set it in your
  // environment without already being able to do worse, and it cannot cause a
  // bad install because the install itself still resolves against the real
  // registry. What it CAN do is hide that an update exists. A silent
  // substitution of trusted data is the part worth refusing, so it is made
  // impossible: if this is in effect, you are told.
  process.stderr.write(
    `ailoud: reading npm versions from the fixture ${fixturePath} (AILOUD_PACKUMENTS is set), not from the registry\n`,
  );
  return async (url) => {
    const name = decodeURIComponent(new URL(url).pathname.slice(1));
    const raw = await readFile(fixturePath, 'utf8');
    const all = JSON.parse(raw) as Record<string, unknown>;
    const packument = all[name];
    if (packument === undefined) return { status: 404, body: '' };
    return { status: 200, body: JSON.stringify(packument) };
  };
}

export interface CliContext {
  readonly paths: AiloudPaths;
  readonly config: AiloudConfig;
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
   * The configured large language model. Throws an EnvironmentError naming
   * what is missing rather than returning null, so a command need not decide
   * how to explain a half-configured engine.
   */
  createSummarizer(): Summarizer;
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
  /**
   * What versions of ailoud are published, for `ailoud self check`. A port,
   * not `NpmRegistry` directly, the same way every other engine on this
   * context is: `createContext` is the only place that knows which provider
   * backs it.
   */
  readonly versionSource: VersionSource;
  /**
   * The registry host and timeout `versionSource` was built with. Kept
   * alongside it rather than read back off it: `VersionSource` only
   * promises `published()`, so a failed lookup could not otherwise name
   * where it looked or how long it waited before giving up -- exactly what
   * a check that could not run must report.
   */
  readonly updateRegistryHost: string;
  readonly updateTimeoutMs: number;
}

async function readConfigFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null; // no config file is the normal first run, not an error
  }
}

/**
 * Records that this run resolved a project's own library, so a later
 * `ailoud self sync` has something to sweep. The per-user library is never
 * entered here: it always exists, so listing it in the registry would only
 * ever be noise.
 *
 * Registration is bookkeeping, not the user's request -- `createContext` runs
 * before every command, including `doctor` and `ls`, and a full disk, a
 * read-only home, or any other write failure here must never fail the
 * command that triggered it. Any error is swallowed down to a single debug
 * line.
 */
async function registerProjectLibrary(fs: Fs, clock: Clock, paths: AiloudPaths): Promise<void> {
  if (!paths.isProjectLibrary) return;
  // `paths.dataDir` IS the project's `.ailoud/` in this branch (see
  // `AiloudPaths.dataDir`'s own doc comment), so the project itself is that
  // directory with the trailing `/.ailoud` stripped back off.
  const projectPath = paths.dataDir.slice(0, -`/${PROJECT_DIR}`.length);
  try {
    await rememberProject(
      { fs, clock, userDataDir: paths.userDataDir },
      { path: projectPath, libraryDir: paths.dataDir },
    );
  } catch (error) {
    process.stderr.write(
      `ailoud: debug: could not register project "${projectPath}": ` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

export async function createContext(
  env: Record<string, string | undefined>,
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<CliContext> {
  // The project library is looked for from the working directory, so a
  // repository with a `.ailoud/` keeps its recordings beside its code.
  const paths = resolvePaths(env, {
    cwd: process.cwd(),
    exists: (path) => existsSync(path) && statSync(path).isDirectory(),
  });
  const raw = await readConfigFile(paths.configFile);
  const config = parseConfig(raw);
  await mkdir(paths.mediaRoot, { recursive: true });
  const fs = new NodeFs();
  const clock = new SystemClock();
  await registerProjectLibrary(fs, clock, paths);
  return {
    paths,
    config,
    store: openStore(paths.dbFile),
    fs,
    audio: new FfmpegAudioTool(),
    clock,
    ids: new UlidIds(),
    write,
    ui: createUi(write),
    createStt(): TranscriptionProvider {
      const model = config.stt.whisperCpp.model;
      if (model === null) {
        throw new EnvironmentError(
          `The whisper.cpp model is not configured. Set "stt.whisperCpp.model" in ` +
            `${paths.configFile} to the path of a model file; run "ailoud doctor" for details.`,
        );
      }
      return new WhisperCppProvider({ binary: config.stt.whisperCpp.binary, modelPath: model });
    },
    createSummarizer(): Summarizer {
      const llm = config.llm;

      if (llm.provider === 'claude-cli') {
        // No key at all: the CLI is already signed in, and borrowing that is
        // the whole point -- someone paying for a subscription should not
        // have to buy API credit to summarise their own recordings.
        return new ClaudeCliSummarizer({
          binary: llm.claudeCli.binary,
          model: llm.claudeCli.model,
          contextTokens: llm.claudeCli.contextTokens,
        });
      }

      if (llm.provider === 'anthropic') {
        const settings = llm.anthropic;
        const apiKey = apiKeyFrom(env, 'ANTHROPIC_API_KEY');
        if (apiKey === undefined) {
          throw new EnvironmentError(
            'No API key for Claude. Set AILOUD_LLM_API_KEY (or ANTHROPIC_API_KEY) in your ' +
              'environment, or switch "llm.provider" to "claude-cli" to use a Claude ' +
              'subscription through the Claude Code CLI instead. Keys are read from the ' +
              `environment on purpose and never from ${paths.configFile}.`,
          );
        }
        return new AnthropicSummarizer({
          baseUrl: settings.baseUrl,
          model: settings.model,
          contextTokens: settings.contextTokens,
          maxOutputTokens: settings.maxOutputTokens,
          apiKey,
        });
      }

      if (llm.provider === 'openai-compatible') {
        const settings = llm.openaiCompatible;
        const apiKey = apiKeyFrom(env, 'OPENAI_API_KEY');
        if (isHostedLlm(settings.baseUrl) && apiKey === undefined) {
          throw new EnvironmentError(
            'No API key for the language model. Set AILOUD_LLM_API_KEY (or OPENAI_API_KEY) in ' +
              'your environment. It is read from the environment on purpose and never from ' +
              `${paths.configFile}.`,
          );
        }
        return new OpenAiCompatibleSummarizer({
          baseUrl: settings.baseUrl,
          model: settings.model,
          contextTokens: settings.contextTokens,
          maxOutputTokens: settings.maxOutputTokens,
          ...(apiKey === undefined ? {} : { apiKey }),
        });
      }

      const settings = llm.llamaCpp;
      if (settings.model === null) {
        throw new EnvironmentError(
          `The language model is not configured. Set "llm.llamaCpp.model" in ${paths.configFile} ` +
            'to the path of a GGUF model file; run "ailoud doctor" for details.',
        );
      }
      return new LlamaCppSummarizer({
        binary: settings.binary,
        modelPath: settings.model,
        contextTokens: settings.contextTokens,
        maxOutputTokens: settings.maxOutputTokens,
        threads: settings.threads,
      });
    },

    createSegmenter(): SpeechSegmenter {
      const vadModel = config.stt.whisperCpp.vadModel;
      if (vadModel === null) {
        throw new EnvironmentError(
          `The whisper VAD model is not configured. Set "stt.whisperCpp.vadModel" in ` +
            `${paths.configFile} to the path of a VAD model file; run "ailoud doctor" for details.`,
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
            `sherpa-onnx pyannote segmentation model; run "ailoud doctor" for details.`,
        );
      }
      const embeddingModel = config.stt.diarization.embeddingModel;
      if (embeddingModel === null) {
        throw new EnvironmentError(
          `The diarization embedding model is not configured. Set ` +
            `"stt.diarization.embeddingModel" in ${paths.configFile} to the path of the ` +
            `sherpa-onnx speaker embedding model; run "ailoud doctor" for details.`,
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
    versionSource: new NpmRegistry({
      registry: UPDATE_REGISTRY,
      timeoutMs: UPDATE_TIMEOUT_MS,
      ...(env['AILOUD_PACKUMENTS'] === undefined || env['AILOUD_PACKUMENTS'] === ''
        ? {}
        : { transport: packumentFixtureTransport(env['AILOUD_PACKUMENTS']) }),
    }),
    updateRegistryHost: new URL(UPDATE_REGISTRY).host,
    updateTimeoutMs: UPDATE_TIMEOUT_MS,
  };
}
