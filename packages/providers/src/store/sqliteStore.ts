import { DatabaseSync } from 'node:sqlite';
import type {
  ManagedRecordingStore,
  Recording,
  RecordingListFilter,
  Segment,
  Transcript,
} from '@laud/core';
import { orderLanguages, pendingMigrations } from '@laud/core';

interface RecordingRow {
  id: string;
  sha256: string;
  source_path: string;
  media_path: string;
  duration_ms: number;
  mime: string;
  title: string | null;
  notes: string | null;
  imported_at: string;
}

interface TranscriptRow {
  id: string;
  recording_id: string;
  provider: string;
  model: string;
  language: string;
  text: string;
  created_at: string;
}

interface LanguageTotalRow {
  transcript_id: string;
  language: string;
  spoken_ms: number;
  first_idx: number;
}

interface SegmentRow {
  id: string;
  transcript_id: string;
  idx: number;
  start_ms: number;
  end_ms: number;
  text: string;
  speaker: string | null;
  language: string | null;
}

const toRecording = (row: RecordingRow): Recording => ({
  id: row.id,
  sha256: row.sha256,
  sourcePath: row.source_path,
  mediaPath: row.media_path,
  durationMs: row.duration_ms,
  mime: row.mime,
  title: row.title,
  notes: row.notes,
  importedAt: row.imported_at,
});

const toTranscript = (row: TranscriptRow): Transcript => ({
  id: row.id,
  recordingId: row.recording_id,
  provider: row.provider,
  model: row.model,
  language: row.language,
  text: row.text,
  createdAt: row.created_at,
});

const toSegment = (row: SegmentRow): Segment => ({
  id: row.id,
  transcriptId: row.transcript_id,
  idx: row.idx,
  startMs: row.start_ms,
  endMs: row.end_ms,
  text: row.text,
  speaker: row.speaker,
  language: row.language,
});

export class SqliteStore implements ManagedRecordingStore {
  constructor(private readonly db: DatabaseSync) {}

  static open(path: string): SqliteStore {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    const store = new SqliteStore(db);
    store.migrate();
    return store;
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    const pending = pendingMigrations(row.user_version);
    if (pending.length === 0) return;
    this.db.exec('BEGIN');
    try {
      for (const migration of pending) {
        for (const statement of migration.statements) this.db.exec(statement);
        // PRAGMA does not accept a bound parameter, and the value is an integer
        // from our own migration list, never user input.
        this.db.exec(`PRAGMA user_version = ${migration.version}`);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  schemaVersion(): number {
    return (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  }

  integrityCheck(): string {
    return (this.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string })
      .integrity_check;
  }

  close(): void {
    this.db.close();
  }

  async insertRecording(r: Recording): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO recording
         (id, sha256, source_path, media_path, duration_ms, mime, title, notes, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id,
        r.sha256,
        r.sourcePath,
        r.mediaPath,
        r.durationMs,
        r.mime,
        r.title,
        r.notes,
        r.importedAt,
      );
  }

  async getRecording(id: string): Promise<Recording | null> {
    const row = this.db.prepare('SELECT * FROM recording WHERE id = ?').get(id) as
      RecordingRow | undefined;
    return row ? toRecording(row) : null;
  }

  async findRecordingBySha(sha256: string): Promise<Recording | null> {
    const row = this.db.prepare('SELECT * FROM recording WHERE sha256 = ?').get(sha256) as
      RecordingRow | undefined;
    return row ? toRecording(row) : null;
  }

  async listRecordings(filter: RecordingListFilter): Promise<Recording[]> {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.ids && filter.ids.length > 0) {
      where.push(`id IN (${filter.ids.map(() => '?').join(', ')})`);
      params.push(...filter.ids);
    }
    if (filter.withoutTranscript === true) {
      where.push('NOT EXISTS (SELECT 1 FROM transcript t WHERE t.recording_id = recording.id)');
    }
    const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    // node:sqlite types .all() as Record<string, SQLOutputValue>[], an index
    // signature type the compiler will not cast directly to our named-field
    // row type as `X[]` (TS2352). The single-row `.get()` casts below compile
    // only because their target type is `X | undefined`, not because arrays
    // are treated differently in general. Routing through `unknown` is the
    // standard, non-`any` escape for that specific TypeScript limitation.
    const rows = this.db
      .prepare(`SELECT * FROM recording${clause} ORDER BY imported_at, id`)
      .all(...params) as unknown as RecordingRow[];
    return rows.map(toRecording);
  }

  async insertTranscript(t: Transcript, segments: readonly Segment[]): Promise<void> {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO transcript
           (id, recording_id, provider, model, language, text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(t.id, t.recordingId, t.provider, t.model, t.language, t.text, t.createdAt);
      const insertSegment = this.db.prepare(
        `INSERT INTO segment
           (id, transcript_id, idx, start_ms, end_ms, text, speaker, language)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const s of segments) {
        insertSegment.run(
          s.id,
          s.transcriptId,
          s.idx,
          s.startMs,
          s.endMs,
          s.text,
          s.speaker,
          s.language,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async latestTranscript(recordingId: string): Promise<Transcript | null> {
    const row = this.db
      .prepare(
        `SELECT * FROM transcript WHERE recording_id = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(recordingId) as TranscriptRow | undefined;
    return row ? toTranscript(row) : null;
  }

  async getTranscript(id: string): Promise<Transcript | null> {
    const row = this.db.prepare('SELECT * FROM transcript WHERE id = ?').get(id) as
      TranscriptRow | undefined;
    return row ? toTranscript(row) : null;
  }

  async listSegments(transcriptId: string): Promise<Segment[]> {
    // See the comment in listRecordings: .all() returns an index signature
    // type, which needs the `unknown` step before it can become our
    // named-field row type.
    const rows = this.db
      .prepare('SELECT * FROM segment WHERE transcript_id = ? ORDER BY idx')
      .all(transcriptId) as unknown as SegmentRow[];
    return rows.map(toSegment);
  }

  async languagesByTranscript(
    transcriptIds: readonly string[],
  ): Promise<Map<string, readonly string[]>> {
    // `IN ()` is a syntax error, and there is nothing to ask about anyway.
    if (transcriptIds.length === 0) return new Map();

    // One aggregate for the whole list, not one query per transcript: this
    // exists so that `ls` can show a language per row without loading the
    // segments of every recording in the library.
    //
    // max(x, 0) clamps a segment whose end precedes its start, matching what
    // summarizeLanguages does in memory -- a negative span must not subtract
    // from a language's total and reorder the result. Rows with no language
    // are excluded here rather than filtered later, so a transcript with no
    // languages recorded produces no rows and stays absent from the map.
    const placeholders = transcriptIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT transcript_id, language,
                SUM(max(end_ms - start_ms, 0)) AS spoken_ms,
                MIN(idx) AS first_idx
         FROM segment
         WHERE transcript_id IN (${placeholders})
           AND language IS NOT NULL AND language <> ''
         GROUP BY transcript_id, language`,
      )
      .all(...transcriptIds) as unknown as LanguageTotalRow[];

    const totalsByTranscript = new Map<
      string,
      { language: string; spokenMs: number; firstIdx: number }[]
    >();
    for (const row of rows) {
      const totals = totalsByTranscript.get(row.transcript_id) ?? [];
      totals.push({ language: row.language, spokenMs: row.spoken_ms, firstIdx: row.first_idx });
      totalsByTranscript.set(row.transcript_id, totals);
    }

    // The ordering rule itself lives in core (orderLanguages), shared with
    // summarizeLanguages, so SQL and TypeScript cannot drift apart on it.
    return new Map(
      [...totalsByTranscript.entries()].map(([id, totals]) => [id, orderLanguages(totals)]),
    );
  }
}

export const openStore = (path: string): SqliteStore => SqliteStore.open(path);
