import type {
  AudioTool,
  Clock,
  Fs,
  Ids,
  ManagedRecordingStore,
  RecordingListFilter,
  TempFile,
  TranscriptionProvider,
} from '../domain/ports.js';
import type { RawSegment, Recording, Segment, Transcript } from '../domain/model.js';
import { SCHEMA_VERSION } from '../db/schema.js';

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
}

export class FakeAudioTool implements AudioTool {
  readonly converted: Array<[string, string]> = [];

  constructor(private readonly durationMs = 60_000) {}

  async probe(): Promise<{ durationMs: number }> {
    return { durationMs: this.durationMs };
  }
  async toWav16kMono(input: string, output: string): Promise<void> {
    this.converted.push([input, output]);
  }
}

export class FakeStt implements TranscriptionProvider {
  readonly name = 'fake';
  readonly capabilities: TranscriptionProvider['capabilities'];
  /** Every opts object this fake was called with, in call order. */
  readonly calls: Array<{ readonly language?: string; readonly model?: string }> = [];

  constructor(
    private readonly result: { language: string; model: string; segments: RawSegment[] },
    capabilities?: Partial<TranscriptionProvider['capabilities']>,
  ) {
    this.capabilities = {
      maxBytes: null,
      supportsDiarization: false,
      supportsLanguageHint: true,
      ...capabilities,
    };
  }

  async transcribe(
    _audioPath: string,
    opts: { readonly language?: string; readonly model?: string },
  ): Promise<{ language: string; model: string; segments: RawSegment[] }> {
    this.calls.push(opts);
    return this.result;
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
