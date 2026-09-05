import type {
  AudioTool,
  Clock,
  Diarizer,
  Fs,
  Ids,
  ManagedRecordingStore,
  RecordingListFilter,
  SegmentSearchFilter,
  SpeakerTurn,
  SpeechSegmenter,
  SpeechSpan,
  TempDir,
  TempFile,
  TranscriptionProvider,
} from '../domain/ports.js';
import type {
  RawSegment,
  Recording,
  Segment,
  SegmentHit,
  SpeakerName,
  Summary,
  Transcript,
} from '../domain/model.js';
import { SCHEMA_VERSION } from '../db/schema.js';
import { summarizeLanguages } from '../transcribe/languages.js';

export class FakeClock implements Clock {
  private ms = Date.parse('2026-01-01T00:00:00.000Z');
  nowIso(): string {
    const iso = new Date(this.ms).toISOString();
    this.ms += 1000;
    return iso;
  }
}

export class FakeIds implements Ids {
  private n = 0;
  next(): string {
    this.n += 1;
    return `ID${String(this.n).padStart(3, '0')}`;
  }
}

export class MemFs implements Fs {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();
  private tempCounter = 0;

  constructor(files: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(files)) this.files.set(path, content);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path);
  }
  async ensureDir(path: string): Promise<void> {
    this.dirs.add(path);
  }
  async sha256(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`no such file: ${path}`);
    // Not a real digest: the tests need identity, not cryptography.
    return `sha-${content}`;
  }
  async copyFile(source: string, destination: string): Promise<void> {
    const content = this.files.get(source);
    if (content === undefined) throw new Error(`no such file: ${source}`);
    this.files.set(destination, content);
  }
  async removeFile(path: string): Promise<void> {
    this.files.delete(path);
  }

  async listFiles(directory: string): Promise<string[]> {
    const prefix = directory.endsWith('/') ? directory : `${directory}/`;
    // Direct children only, like readdir(): a path one level deeper (a
    // nested "/" past the prefix) belongs to a subdirectory, not this one.
    return [...this.files.keys()]
      .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .sort();
  }
  async isDirectory(path: string): Promise<boolean> {
    return this.dirs.has(path);
  }
  async tempFile(extension: string): Promise<TempFile> {
    this.tempCounter += 1;
    const path = `/tmp/fake-${this.tempCounter}${extension}`;
    return {
      path,
      remove: async () => {
        this.files.delete(path);
      },
    };
  }
  async tempDir(): Promise<TempDir> {
    this.tempCounter += 1;
    const path = `/tmp/fake-dir-${this.tempCounter}`;
    this.dirs.add(path);
    return {
      path,
      remove: async () => {
        this.dirs.delete(path);
        for (const key of [...this.files.keys()]) {
          if (key.startsWith(`${path}/`)) this.files.delete(key);
        }
      },
    };
  }
  async writeTextFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
  async readTextFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined)
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return content;
  }
  async rename(from: string, to: string): Promise<void> {
    const content = this.files.get(from);
    if (content === undefined)
      throw Object.assign(new Error(`ENOENT: ${from}`), { code: 'ENOENT' });
    this.files.set(to, content);
    this.files.delete(from);
  }
}

export class FakeAudioTool implements AudioTool {
  readonly converted: Array<[string, string]> = [];
  /** Every slice() call this fake was given, in call order. */
  readonly sliced: Array<{ input: string; output: string; startMs: number; endMs: number }> = [];

  constructor(
    private readonly durationMs = 60_000,
    private readonly fs?: MemFs,
    /**
     * What probe() reports as the container's creation time. Null by default
     * because that is the common real case -- wav carries no such tag -- so a
     * test that does not care about dates exercises the fallback path.
     */
    private readonly recordedAt: string | null = null,
  ) {}

  async probe(): Promise<{ durationMs: number; recordedAt: string | null }> {
    return { durationMs: this.durationMs, recordedAt: this.recordedAt };
  }
  async toWav16kMono(input: string, output: string): Promise<void> {
    this.converted.push([input, output]);
  }
  async slice(input: string, output: string, startMs: number, endMs: number): Promise<void> {
    this.sliced.push({ input, output, startMs, endMs });
    // Really creates the output in the fake filesystem, so cleanup after the
    // slice is used can be observed rather than trivially true.
    if (this.fs !== undefined) this.fs.files.set(output, `slice:${input}:${startMs}-${endMs}`);
  }
}

export class FakeStt implements TranscriptionProvider {
  readonly name = 'fake';
  readonly capabilities: TranscriptionProvider['capabilities'];
  /** Every opts object this fake was called with, in call order. */
  readonly calls: Array<{ readonly language?: string; readonly model?: string }> = [];
  /** Every audio path handed to transcribe(), in call order. */
  readonly transcribePaths: string[] = [];
  /** Every audio path handed to detectLanguage(), in call order. */
  readonly detectLanguageCalls: string[] = [];
  /** Every opts object handed to detectLanguage(), in call order. */
  readonly detectLanguageOpts: Array<{ readonly model?: string }> = [];

  private readonly results: ReadonlyArray<{
    language: string;
    model: string;
    segments: RawSegment[];
  }>;
  private readonly languageQueue: string[];

  constructor(
    result:
      | { language: string; model: string; segments: RawSegment[] }
      | ReadonlyArray<{ language: string; model: string; segments: RawSegment[] }>,
    capabilities?: Partial<TranscriptionProvider['capabilities']>,
    detectedLanguages: readonly string[] = [],
  ) {
    this.results = Array.isArray(result) ? result : [result];
    this.languageQueue = [...detectedLanguages];
    this.capabilities = {
      maxBytes: null,
      supportsDiarization: false,
      supportsLanguageHint: true,
      supportsLanguageDetection: false,
      ...capabilities,
    };
  }

  async transcribe(
    audioPath: string,
    opts: { readonly language?: string; readonly model?: string },
  ): Promise<{ language: string; model: string; segments: RawSegment[] }> {
    this.transcribePaths.push(audioPath);
    const result = this.results[this.calls.length] ?? this.results.at(-1);
    this.calls.push(opts);
    if (result === undefined) throw new Error('FakeStt has no canned result to return');
    return result;
  }

  /** Returns languages from the queue passed at construction, in order. */
  async detectLanguage(audioPath: string, opts: { readonly model?: string } = {}): Promise<string> {
    this.detectLanguageCalls.push(audioPath);
    this.detectLanguageOpts.push(opts);
    const language = this.languageQueue.shift();
    if (language === undefined) throw new Error('FakeStt.detectLanguage queue is exhausted');
    return language;
  }
}

export class FakeSegmenter implements SpeechSegmenter {
  /** Every audio path this fake was asked to segment, in call order. */
  readonly calls: string[] = [];

  constructor(private readonly spans: readonly SpeechSpan[]) {}

  async segments(audioPath: string): Promise<SpeechSpan[]> {
    this.calls.push(audioPath);
    return [...this.spans];
  }
}

export class FakeDiarizer implements Diarizer {
  /** Every (audioPath, options) pair this fake was asked to diarize, in call order. */
  readonly calls: Array<{ readonly audioPath: string; readonly speakers?: number }> = [];

  constructor(private readonly turnsResult: readonly SpeakerTurn[]) {}

  async turns(
    audioPath: string,
    options: { readonly speakers?: number } = {},
  ): Promise<readonly SpeakerTurn[]> {
    this.calls.push({
      audioPath,
      ...(options.speakers === undefined ? {} : { speakers: options.speakers }),
    });
    return [...this.turnsResult];
  }
}

export class InMemoryStore implements ManagedRecordingStore {
  readonly recordings = new Map<string, Recording>();
  readonly transcripts = new Map<string, Transcript>();
  readonly segments = new Map<string, Segment[]>();

  async findRecordingBySha(sha256: string): Promise<Recording | null> {
    return [...this.recordings.values()].find((r) => r.sha256 === sha256) ?? null;
  }
  async getRecording(id: string): Promise<Recording | null> {
    return this.recordings.get(id) ?? null;
  }
  async insertRecording(recording: Recording): Promise<void> {
    this.recordings.set(recording.id, recording);
  }
  async listRecordings(filter: RecordingListFilter): Promise<Recording[]> {
    let all = [...this.recordings.values()];
    if (filter.ids && filter.ids.length > 0) {
      const ids = filter.ids;
      all = all.filter((r) => ids.includes(r.id));
    }
    if (filter.withoutTranscript === true) {
      const done = new Set([...this.transcripts.values()].map((t) => t.recordingId));
      all = all.filter((r) => !done.has(r.id));
    }
    if (filter.tags && filter.tags.length > 0) {
      // Every tag, not any: mirrors the real store, where a second tag
      // narrows rather than widens.
      const wanted = filter.tags;
      all = all.filter((r) => {
        const have = this.tags.get(r.id) ?? new Set<string>();
        return wanted.every((tag) => have.has(tag));
      });
    }
    // Mirrors SqliteStore's `ORDER BY imported_at, id`: imported_at is not
    // unique, so id is the deterministic tie-break.
    return all.sort((a, b) => a.importedAt.localeCompare(b.importedAt) || a.id.localeCompare(b.id));
  }
  async insertTranscript(t: Transcript, segments: readonly Segment[]): Promise<void> {
    this.transcripts.set(t.id, t);
    this.segments.set(
      t.id,
      [...segments].sort((a, b) => a.idx - b.idx),
    );
  }
  async latestTranscript(recordingId: string): Promise<Transcript | null> {
    return (
      [...this.transcripts.values()]
        .filter((t) => t.recordingId === recordingId)
        // Mirrors SqliteStore's `ORDER BY created_at DESC, id DESC`:
        // created_at is not unique, so id is the deterministic tie-break.
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0] ??
      null
    );
  }
  async listSegments(transcriptId: string): Promise<Segment[]> {
    // Mirrors SqliteStore's `ORDER BY idx`: insertTranscript already sorts
    // by idx before storing, this just keeps the contract explicit here too.
    return [...(this.segments.get(transcriptId) ?? [])].sort((a, b) => a.idx - b.idx);
  }
  async findRecordingsByIdPrefix(prefix: string): Promise<Recording[]> {
    if (prefix === '') return [];
    return [...this.recordings.values()]
      .filter((recording) => recording.id.startsWith(prefix))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async findTranscriptsByIdPrefix(prefix: string): Promise<Transcript[]> {
    if (prefix === '') return [];
    return [...this.transcripts.values()]
      .filter((transcript) => transcript.id.startsWith(prefix))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  readonly speakerNames = new Map<string, Map<string, string>>();
  readonly summaries: Summary[] = [];

  readonly tags = new Map<string, Set<string>>();

  async addTags(recordingId: string, tags: readonly string[]): Promise<void> {
    const existing = this.tags.get(recordingId) ?? new Set<string>();
    for (const tag of tags) existing.add(tag);
    this.tags.set(recordingId, existing);
  }

  async listTags(recordingId: string): Promise<string[]> {
    return [...(this.tags.get(recordingId) ?? [])].sort();
  }

  async listAllTags(): Promise<{ tag: string; count: number }[]> {
    const counts = new Map<string, number>();
    for (const tags of this.tags.values()) {
      for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  /**
   * Substring search, standing in for the real store's FTS5.
   *
   * Deliberately not a reimplementation of FTS5 syntax: this fake exists so a
   * command's behaviour can be tested, and a second search engine here would
   * be a second thing to keep correct. It strips the quoting that
   * toMatchExpression adds and matches case-insensitively on each term.
   */
  async searchSegments(match: string, filter: SegmentSearchFilter): Promise<SegmentHit[]> {
    const terms = [...match.matchAll(/"([^"]*)"/g)].map(([, term]) => term!.toLowerCase());
    const hits: SegmentHit[] = [];
    for (const recording of this.recordings.values()) {
      const ids = filter.recordingIds ?? [];
      if (ids.length > 0 && !ids.includes(recording.id)) continue;
      const wanted = filter.tags ?? [];
      const carried = this.tags.get(recording.id) ?? new Set<string>();
      if (wanted.some((tag) => !carried.has(tag))) continue;

      const transcripts = [...this.transcripts.values()]
        .filter((transcript) => transcript.recordingId === recording.id)
        // createdAt then id, matching the real store's subquery AND this fake's
        // own latestTranscript. Without the id tie-break the fake contradicted
        // itself on two transcripts sharing a timestamp.
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      const chosen = filter.allTranscripts === true ? transcripts : transcripts.slice(0, 1);
      for (const transcript of chosen) {
        for (const segment of this.segments.get(transcript.id) ?? []) {
          if (filter.language !== undefined && segment.language !== filter.language) continue;
          const lower = segment.text.toLowerCase();
          if (!terms.every((term) => lower.includes(term))) continue;
          hits.push({
            recordingId: recording.id,
            recordingTitle: recording.title,
            recordedAt: recording.recordedAt ?? recording.importedAt,
            tags: [...carried].sort(),
            transcriptId: transcript.id,
            segmentId: segment.id,
            startMs: segment.startMs,
            endMs: segment.endMs,
            speaker: segment.speaker,
            language: segment.language,
            text: segment.text,
          });
        }
      }
    }
    return hits.slice(0, filter.limit ?? 50);
  }

  async insertSummary(summary: Summary): Promise<void> {
    this.summaries.push(summary);
  }

  async latestSummaryOf(recordingId: string): Promise<Summary | null> {
    // Covering this recording and nothing else: a group summary of ten
    // meetings is not the summary of the third one.
    const own = this.summaries
      .filter(
        (summary) => summary.recordingIds.length === 1 && summary.recordingIds[0] === recordingId,
      )
      // Newest by createdAt then id, as the real store orders it. Returning
      // the last INSERTED one diverged: insert a 2026-01-02 summary then a
      // 2026-01-01 one and the two stores disagreed about which was newest.
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return own[0] ?? null;
  }

  async listSummaries(recordingId: string): Promise<Summary[]> {
    // Same order as the real store: newest first by createdAt then id, not
    // reverse insertion order.
    return this.summaries
      .filter((summary) => summary.recordingIds.includes(recordingId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  async listAllSummaries(): Promise<Summary[]> {
    return [...this.summaries].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
  }

  async findSummariesByIdPrefix(prefix: string): Promise<Summary[]> {
    // Same guard the real store applies, or a test would prove the wrong
    // thing: the real one refuses a prefix carrying a LIKE wildcard.
    if (prefix === '' || !/^[0-9A-Za-z]+$/.test(prefix)) return [];
    return this.summaries
      .filter((summary) => summary.id.startsWith(prefix))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async deleteSummary(id: string): Promise<boolean> {
    const at = this.summaries.findIndex((summary) => summary.id === id);
    if (at === -1) return false;
    this.summaries.splice(at, 1);
    return true;
  }

  async setSpeakerName(recordingId: string, label: string, name: string): Promise<void> {
    const byLabel = this.speakerNames.get(recordingId) ?? new Map<string, string>();
    byLabel.set(label, name);
    this.speakerNames.set(recordingId, byLabel);
  }

  async listSpeakerNames(recordingId: string): Promise<SpeakerName[]> {
    const byLabel = this.speakerNames.get(recordingId);
    if (byLabel === undefined) return [];
    return [...byLabel.entries()]
      .map(([label, name]) => ({ label, name }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  async annotateRecording(
    id: string,
    fields: { readonly title?: string; readonly notes?: string },
  ): Promise<void> {
    const recording = this.recordings.get(id);
    if (recording === undefined) return;
    this.recordings.set(id, {
      ...recording,
      title: fields.title ?? recording.title,
      notes: fields.notes ?? recording.notes,
    });
  }

  async deleteRecording(id: string): Promise<boolean> {
    if (!this.recordings.has(id)) return false;
    this.recordings.delete(id);
    // Mirrors the speaker table's ON DELETE CASCADE.
    this.speakerNames.delete(id);
    this.tags.delete(id);
    // Mirrors ON DELETE CASCADE in the real schema: a transcript cannot
    // outlive its recording, nor a segment its transcript. A fake that kept
    // them would let a test pass against behaviour the real store does not
    // have.
    for (const [transcriptId, transcript] of [...this.transcripts]) {
      if (transcript.recordingId !== id) continue;
      this.transcripts.delete(transcriptId);
      this.segments.delete(transcriptId);
    }
    return true;
  }

  async languagesByTranscript(
    transcriptIds: readonly string[],
  ): Promise<Map<string, readonly string[]>> {
    // Built from the same summarizeLanguages the real store's SQL aggregate
    // is written to match, so a test passing against this fake is evidence
    // about the contract rather than about the fake.
    const result = new Map<string, readonly string[]>();
    for (const id of transcriptIds) {
      const segments = this.segments.get(id);
      if (segments === undefined) continue;
      const languages = summarizeLanguages(segments);
      if (languages.length > 0) result.set(id, languages);
    }
    return result;
  }
  async getTranscript(id: string): Promise<Transcript | null> {
    return this.transcripts.get(id) ?? null;
  }
  /** Nothing to release: there is no underlying handle to close. */
  close(): void {}
  /** Matches the real schema this fake stands in for, not a stub value. */
  schemaVersion(): number {
    return SCHEMA_VERSION;
  }
  /** There is no real database to corrupt, so this always reports healthy. */
  integrityCheck(): string {
    return 'ok';
  }
}
