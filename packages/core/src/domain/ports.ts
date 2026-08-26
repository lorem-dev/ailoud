import type { Recording, RawSegment, Segment, Transcript } from './model.js';

export interface Clock {
  nowIso(): string;
}

export interface Ids {
  next(): string;
}

/**
 * A temporary file handle that owns whatever storage backs it. On the real
 * filesystem that is a directory allocated just for this file; `remove()`
 * drops the whole thing, including anything a provider writes alongside
 * the file itself (for example whisper-cli's JSON sidecar). Callers must
 * not assume anything about how `path` is laid out on disk.
 */
export interface TempFile {
  readonly path: string;
  remove(): Promise<void>;
}

export interface Fs {
  exists(path: string): Promise<boolean>;
  ensureDir(path: string): Promise<void>;
  /** Streaming, so a three-hour recording is not read into memory. */
  sha256(path: string): Promise<string>;
  copyFile(source: string, destination: string): Promise<void>;
  listFiles(directory: string): Promise<string[]>;
  isDirectory(path: string): Promise<boolean>;
  tempFile(extension: string): Promise<TempFile>;
}

export interface AudioTool {
  probe(path: string): Promise<{ durationMs: number }>;
  toWav16kMono(input: string, output: string): Promise<void>;
}

export interface TranscriptionProvider {
  readonly name: string;
  readonly capabilities: {
    /** null means the provider accepts any size. */
    readonly maxBytes: number | null;
    readonly supportsDiarization: boolean;
    readonly supportsLanguageHint: boolean;
  };
  transcribe(
    audioPath: string,
    opts: { readonly language?: string; readonly model?: string },
  ): Promise<{ language: string; model: string; segments: RawSegment[] }>;
}

export interface RecordingListFilter {
  readonly ids?: readonly string[];
  readonly withoutTranscript?: boolean;
}

export interface RecordingStore {
  findRecordingBySha(sha256: string): Promise<Recording | null>;
  getRecording(id: string): Promise<Recording | null>;
  insertRecording(recording: Recording): Promise<void>;
  listRecordings(filter: RecordingListFilter): Promise<Recording[]>;
  /** Transcript and its segments are written in one transaction. */
  insertTranscript(transcript: Transcript, segments: readonly Segment[]): Promise<void>;
  latestTranscript(recordingId: string): Promise<Transcript | null>;
  /** Looks up a transcript by its own id, regardless of which recording it belongs to. */
  getTranscript(id: string): Promise<Transcript | null>;
  listSegments(transcriptId: string): Promise<Segment[]>;
}

/**
 * A `RecordingStore` with the lifecycle and health-check operations the CLI
 * shell needs around it, beyond what the pipelines themselves require:
 * closing the underlying handle, and the two facts `doctor` reports about
 * the database.
 */
export interface ManagedRecordingStore extends RecordingStore {
  close(): void;
  /** The schema version currently applied to the database (`PRAGMA user_version`). */
  schemaVersion(): number;
  /** SQLite's own `PRAGMA integrity_check` result; "ok" means the database is healthy. */
  integrityCheck(): string;
}
