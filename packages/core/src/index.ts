export type { Recording, Transcript, Segment, RawSegment } from './domain/model.js';

export type {
  Clock,
  Ids,
  Fs,
  TempFile,
  AudioTool,
  TranscriptionProvider,
  SpeechSpan,
  SpeechSegmenter,
  RecordingListFilter,
  RecordingStore,
  ManagedRecordingStore,
} from './domain/ports.js';

export type { Migration } from './db/schema.js';

export type { DetectedSpan, LanguageRun } from './transcribe/merge.js';

export {
  MIN_RUN_DURATION_MS,
  MAX_DETECTION_WINDOW_MS,
  mergeRuns,
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
