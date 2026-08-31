export type { RawSegment, Recording, Segment, SpeakerName, Transcript } from './domain/model.js';

export type {
  AudioTool,
  Clock,
  Diarizer,
  Fs,
  Ids,
  ManagedRecordingStore,
  RecordingListFilter,
  RecordingStore,
  SpeakerTurn,
  SpeechSegmenter,
  SpeechSpan,
  Summarizer,
  TempFile,
  TranscriptionProvider,
} from './domain/ports.js';

export type { Migration } from './db/schema.js';

export type { DetectedSpan, LanguageRun } from './transcribe/merge.js';
export { orderLanguages, summarizeLanguages } from './transcribe/languages.js';
export type { LanguageTotal } from './transcribe/languages.js';

export { assignSpeakers } from './diarize/assign.js';
export {
  formatRecordedAt,
  normalizeRecordedAt,
  recordedOrImportedAt,
} from './domain/recordedAt.js';
export { resolveBySpeaker } from './transcribe/bySpeaker.js';
export {
  segmentsOfSpeaker,
  speakerDisplayName,
  speakerNameMap,
  summarizeSpeakers,
} from './transcribe/speakers.js';
export type { SpeakerSummary } from './transcribe/speakers.js';
export type { DetectedTurn } from './transcribe/bySpeaker.js';

export {
  MIN_RUN_DURATION_MS,
  MAX_DETECTION_WINDOW_MS,
  DECLARED_DETECTION_WINDOW_MS,
  detectionWindowMs,
  mergeRuns,
  resolveDeclaredLanguages,
  subdivideSpans,
} from './transcribe/merge.js';

export { LaudError, FailureError, UsageError, EnvironmentError } from './domain/errors.js';

export { encodeUlid } from './domain/ulid.js';

export { mimeForPath } from './domain/mime.js';

export { MIGRATIONS, SCHEMA_VERSION, pendingMigrations } from './db/schema.js';

export { importRecording, importPath } from './pipelines/import.js';

export type { ImportDeps, ImportRequest, ImportResult } from './pipelines/import.js';

export { transcribeRecording } from './pipelines/transcribe.js';

export type { TranscribeDeps, TranscribeOptions } from './pipelines/transcribe.js';

export { formatTimestamp, toSrt, toVtt } from './format/subtitles.js';

export { toPlainText } from './format/text.js';
export { quoteSample, truncateSample } from './format/sample.js';
export { formatDuration } from './format/duration.js';

export type { Remedy, InstallTarget, LlmProvider } from './provision/remedy.js';

export { installHint, WINDOWS_MANUAL_HINT, LLM_PROVIDERS } from './provision/remedy.js';

export type { ModelChoice } from './provision/catalogue.js';

export {
  TRANSCRIPTION_MODELS,
  VAD_MODEL,
  SEGMENTATION_MODEL,
  EMBEDDING_MODEL,
  DEFAULT_MODEL_NAME,
  findModel,
} from './provision/catalogue.js';

export type { Action, PlanOptions } from './provision/plan.js';

export { planProvisioning, planDownloadBytes } from './provision/plan.js';

export { chunkTranscript, estimateTokens, transcriptLine } from './summarize/chunk.js';
export { buildSummaryRequest, sourceHeading } from './summarize/prompt.js';
export type { SummaryRequest, SummarySource } from './summarize/prompt.js';
