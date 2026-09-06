export { SqliteStore, openStore } from './store/sqliteStore.js';

export { run, runInteractive } from './process/run.js';
export type { RunResult, RunOptions } from './process/run.js';

export {
  detectPackageManager,
  ffmpegInstallCommands,
  formatInstallCommand,
  whisperInstallCommands,
} from './provision/packageManager.js';
export type { PackageManager, InstallCommand, BinaryProbe } from './provision/packageManager.js';

export { downloadFile } from './provision/download.js';
export type { DownloadOptions } from './provision/download.js';

export { WHISPER_TAG, whisperTarballUrl, installWhisper } from './provision/whisperInstall.js';
export type {
  InstallWhisperOptions,
  InstallWhisperResult,
  WhisperPaths,
} from './provision/whisperInstall.js';

export { SHERPA_VERSION, sherpaTarballUrl, installSherpa } from './provision/sherpaInstall.js';
export type { InstallSherpaOptions } from './provision/sherpaInstall.js';

export { NodeFs } from './system/nodeFs.js';
export { SystemClock, UlidIds } from './system/systemClock.js';

export { FfmpegAudioTool } from './audio/ffmpeg.js';

export { WhisperCppProvider, parseWhisperJson } from './stt/whisperCpp.js';
export type { WhisperCppOptions } from './stt/whisperCpp.js';

export { WhisperVadSegmenter, parseVadSegments } from './vad/whisperVad.js';
export type { WhisperVadOptions } from './vad/whisperVad.js';

export { SherpaDiarizer, parseSpeakerTurns } from './diarize/sherpaDiarizer.js';
export type { SherpaDiarizerOptions } from './diarize/sherpaDiarizer.js';

export { PAGER_LINE_THRESHOLD, page, shouldPage } from './process/pager.js';
export { LlamaCppSummarizer, cleanCompletion } from './llm/llamaCpp.js';
export type { LlamaCppOptions } from './llm/llamaCpp.js';
export { OpenAiCompatibleSummarizer, extractCompletion } from './llm/openAiCompatible.js';
export type { OpenAiCompatibleOptions } from './llm/openAiCompatible.js';
export { AnthropicSummarizer, extractAnthropicText } from './llm/anthropic.js';
export type { AnthropicOptions } from './llm/anthropic.js';
export { ClaudeCliSummarizer } from './llm/claudeCli.js';
export type { ClaudeCliOptions } from './llm/claudeCli.js';
export { listOpenAiModels, listAnthropicModels, isChatModel } from './llm/models.js';
export type { ModelOption } from './llm/models.js';
export { LLAMA_VERSION, installLlama, llamaTarballUrl } from './provision/llamaInstall.js';
export type { InstallLlamaOptions, InstallLlamaResult } from './provision/llamaInstall.js';

export { DEFAULT_REGISTRY, DEFAULT_TIMEOUT_MS, NpmRegistry } from './update/npmRegistry.js';
export type { RegistryTransport } from './update/npmRegistry.js';
export type { NpmRegistryOptions } from './update/npmRegistry.js';

export { detectInstallMethod, installCommandFor, sweepCommandFor } from './update/installMethod.js';
export type { InstallMethod, DetectOptions } from './update/installMethod.js';
