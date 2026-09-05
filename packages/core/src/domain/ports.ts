import type {
  RawSegment,
  Recording,
  Segment,
  SegmentHit,
  SpeakerName,
  Summary,
  Transcript,
} from './model.js';

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

/**
 * A directory that exists for the length of one operation.
 *
 * Separate from TempFile because a summary run needs several files at once --
 * one transcript per recording -- and needs them to have meaningful names
 * rather than whatever a per-file temp helper chose.
 */
export interface TempDir {
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
  /** A fresh empty directory the caller names the contents of, and removes when done. */
  tempDir(): Promise<TempDir>;
  /** Writes text, creating the file or replacing it. */
  writeTextFile(path: string, content: string): Promise<void>;
  /** Reads text. Rejects when the file is not there -- callers check `exists` first. */
  readTextFile(path: string): Promise<string>;
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

/**
 * A large language model, behind one interface whatever is answering.
 *
 * Deliberately narrow: one string in, one string out. Everything that varies
 * between a local llama.cpp process and a hosted API -- model names, context
 * windows, keys, retries -- belongs to the adapter, and none of it belongs in
 * the pipeline that asks the question.
 *
 * `contextTokens` is the one thing a caller cannot avoid knowing: it decides
 * whether a transcript has to be split before it can be sent, which happens
 * before any request is made.
 */
export interface Summarizer {
  /** For error messages and `doctor`, e.g. "llama.cpp" or "openai". */
  readonly name: string;
  /**
   * Which model this is, as the provider names it.
   *
   * Stored with every summary: a summary reused later as context is worth
   * less if nobody can tell whether haiku or opus wrote it.
   */
  readonly model: string;
  /** How much the model can be shown at once, in tokens. */
  readonly contextTokens: number;
  complete(prompt: string): Promise<string>;
}

export interface RecordingListFilter {
  /** Only recordings carrying every one of these tags. */
  readonly tags?: readonly string[];
  readonly ids?: readonly string[];
  readonly withoutTranscript?: boolean;
}

export interface SegmentSearchFilter {
  /** Only recordings carrying all of these. */
  readonly tags?: readonly string[];
  /** Only segments spoken in this language. */
  readonly language?: string;
  /** Only these recordings. */
  readonly recordingIds?: readonly string[];
  /** How many hits at most. The caller is told when it was reached. */
  readonly limit?: number;
  /**
   * Search only each recording's newest transcript, which is the default.
   *
   * A recording re-transcribed with `--force` has several, and searching all
   * of them returns the same sentence two or three times over -- which reads
   * as three separate occurrences.
   */
  readonly allTranscripts?: boolean;
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
   * Segments matching a full-text query, most relevant first.
   *
   * Segments rather than recordings, and never whole transcripts: the question
   * "where was this discussed" is answered by a timestamp and a line, and
   * returning the transcript would make the caller read a thousand lines to
   * find the one they asked for.
   */
  searchSegments(match: string, filter: SegmentSearchFilter): Promise<SegmentHit[]>;
  /** Stores a summary and the recordings it covers, in one transaction. */
  insertSummary(summary: Summary): Promise<void>;
  /**
   * The newest summary covering exactly this one recording, or null.
   *
   * "Exactly this one" rather than "any that includes it": a group summary of
   * ten meetings is not a summary of the third one, and reusing it as though
   * it were would put nine other meetings into an answer about one.
   */
  latestSummaryOf(recordingId: string): Promise<Summary | null>;
  /** Every summary touching this recording, newest first. */
  listSummaries(recordingId: string): Promise<Summary[]>;
  /** Every stored summary, newest first. */
  listAllSummaries(): Promise<Summary[]>;
  /** Every summary whose id starts with `prefix`, in id order. See findRecordingsByIdPrefix. */
  findSummariesByIdPrefix(prefix: string): Promise<Summary[]>;
  /**
   * Deletes a summary and its links to recordings. False when there was none.
   *
   * Deleting a summary never touches a recording or a transcript: it is a
   * derived thing, and the material it was derived from is what the library is
   * for.
   */
  deleteSummary(id: string): Promise<boolean>;
  /** Sets or replaces the human name for one diarizer label of one recording. */
  setSpeakerName(recordingId: string, label: string, name: string): Promise<void>;
  /** Every named speaker of a recording, in label order. */
  listSpeakerNames(recordingId: string): Promise<SpeakerName[]>;
  /** Adds tags to a recording. Adding one it already has is a no-op, not an error. */
  addTags(recordingId: string, tags: readonly string[]): Promise<void>;
  /** A recording's tags, alphabetically. */
  listTags(recordingId: string): Promise<string[]>;
  /** Every tag in the library with how many recordings carry it, most-used first. */
  listAllTags(): Promise<{ tag: string; count: number }[]>;
  /** Sets the recording's title or notes. Undefined fields are left as they are. */
  annotateRecording(
    id: string,
    fields: { readonly title?: string; readonly notes?: string },
  ): Promise<void>;
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
