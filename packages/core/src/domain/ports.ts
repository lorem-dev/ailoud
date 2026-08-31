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
  /**
   * Deletes a file. Absent is success: the caller wanted it gone, and it is.
   * Callers delete laud's own copy of a recording, never the file the user
   * imported from.
   */
  removeFile(path: string): Promise<void>;
  isDirectory(path: string): Promise<boolean>;
  tempFile(extension: string): Promise<TempFile>;
}

export interface AudioTool {
  /**
   * Container facts. `recordedAt` is the creation-time tag normalised to an
   * ISO instant, or null when the file carries none or carries a
   * placeholder -- see normalizeRecordedAt. Returned from the same call as
   * the duration rather than a second one: it is the same ffprobe read, and
   * splitting it would double the cost of importing every file.
   */
  probe(path: string): Promise<{ durationMs: number; recordedAt: string | null }>;
  toWav16kMono(input: string, output: string): Promise<void>;
  /**
   * Writes the audio between `startMs` and `endMs` to `output`. This is the
   * audio-splitting work M1 deferred, in the shape the multilingual path
   * needs: not "break into pieces under N bytes" but "give me this range".
   */
  slice(input: string, output: string, startMs: number, endMs: number): Promise<void>;
}

export interface TranscriptionProvider {
  readonly name: string;
  readonly capabilities: {
    /** null means the provider accepts any size. */
    readonly maxBytes: number | null;
    readonly supportsDiarization: boolean;
    readonly supportsLanguageHint: boolean;
    readonly supportsLanguageDetection: boolean;
  };
  transcribe(
    audioPath: string,
    opts: { readonly language?: string; readonly model?: string },
  ): Promise<{ language: string; model: string; segments: RawSegment[] }>;
  /**
   * Detects the language spoken in `audioPath` without transcribing it.
   * Present only when `capabilities.supportsLanguageDetection` is true; the
   * multilingual pipeline refuses a provider that lacks it rather than
   * guessing. Takes the same `model` override its sibling `transcribe` does,
   * so a `--model` override reaches detection as well as transcription
   * rather than leaving detection pinned to the configured default.
   */
  detectLanguage?(audioPath: string, opts: { readonly model?: string }): Promise<string>;
}

/**
 * A stretch of a recording that contains speech, as found by a voice
 * activity detector. Times are absolute milliseconds from the start of the
 * recording. The gaps between spans are silence and belong to no span.
 */
export interface SpeechSpan {
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * Finds where speech happens. Separate from `AudioTool` because it is a
 * different responsibility over a different binary: `AudioTool` is ffmpeg.
 *
 * This is what makes multilingual transcription possible on audio with no
 * measurable pauses -- signal-level silence detection finds nothing on a
 * recording whose clauses were spoken back to back.
 */
export interface SpeechSegmenter {
  segments(audioPath: string): Promise<SpeechSpan[]>;
}

export interface SpeakerTurn {
  readonly startMs: number;
  readonly endMs: number;
  /** Provider-assigned label, e.g. "speaker_00". Not a person's name. */
  readonly speaker: string;
}

export interface Diarizer {
  /** Speaker turns across the whole recording, in timeline order. */
  turns(
    audioPath: string,
    options?: { readonly speakers?: number },
  ): Promise<readonly SpeakerTurn[]>;
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
  /**
   * Deletes a recording and everything hanging off it.
   *
   * Transcripts and segments go with it through ON DELETE CASCADE, which the
   * store enables with `PRAGMA foreign_keys = ON`. Returns false when no
   * such recording existed, so a caller can tell "deleted" from "was not
   * there" instead of guessing.
   */
  deleteRecording(id: string): Promise<boolean>;
  /**
   * Every recording whose id starts with `prefix`, in id order.
   *
   * Ids are ULIDs and begin with a timestamp, so recordings imported near
   * each other share long prefixes -- a short prefix matching several is the
   * ordinary case, not an edge one. Returns them all rather than just the
   * first: the caller has to say how many it found, and showing "several"
   * without a number is the kind of error message that makes people run the
   * command again to learn nothing new.
   */
  findRecordingsByIdPrefix(prefix: string): Promise<Recording[]>;
  /** As `findRecordingsByIdPrefix`, for transcripts. Same reasoning, same shape. */
  findTranscriptsByIdPrefix(prefix: string): Promise<Transcript[]>;
  /**
   * The languages each of these transcripts is spoken in, most-spoken first.
   *
   * Batched deliberately. `ls` renders a language per row, and asking for the
   * segments of every listed recording would load every word of the library
   * to draw one column. Implementations answer this from an aggregate, not by
   * fetching segments.
   *
   * Transcripts with no per-segment language recorded are absent from the
   * result rather than mapping to an empty array, so a caller can tell "no
   * languages recorded" from "this transcript was not asked about".
   */
  languagesByTranscript(transcriptIds: readonly string[]): Promise<Map<string, readonly string[]>>;
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
