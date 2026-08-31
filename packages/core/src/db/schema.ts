export interface Migration {
  readonly version: number;
  readonly statements: readonly string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE recording (
         id TEXT PRIMARY KEY,
         sha256 TEXT NOT NULL UNIQUE,
         source_path TEXT NOT NULL,
         media_path TEXT NOT NULL,
         duration_ms INTEGER NOT NULL,
         mime TEXT NOT NULL,
         title TEXT,
         notes TEXT,
         imported_at TEXT NOT NULL
       )`,
      `CREATE TABLE transcript (
         id TEXT PRIMARY KEY,
         recording_id TEXT NOT NULL REFERENCES recording(id) ON DELETE CASCADE,
         provider TEXT NOT NULL,
         model TEXT NOT NULL,
         language TEXT NOT NULL,
         text TEXT NOT NULL,
         created_at TEXT NOT NULL
       )`,
      `CREATE INDEX transcript_by_recording ON transcript(recording_id, created_at DESC)`,
      `CREATE TABLE segment (
         id TEXT PRIMARY KEY,
         transcript_id TEXT NOT NULL REFERENCES transcript(id) ON DELETE CASCADE,
         idx INTEGER NOT NULL,
         start_ms INTEGER NOT NULL,
         end_ms INTEGER NOT NULL,
         text TEXT NOT NULL,
         speaker TEXT,
         language TEXT,
         UNIQUE (transcript_id, idx)
       )`,
      `CREATE VIRTUAL TABLE segment_fts USING fts5(
         text, content='segment', content_rowid='rowid'
       )`,
      `CREATE TRIGGER segment_ai AFTER INSERT ON segment BEGIN
         INSERT INTO segment_fts(rowid, text) VALUES (new.rowid, new.text);
       END`,
      `CREATE TRIGGER segment_ad AFTER DELETE ON segment BEGIN
         INSERT INTO segment_fts(segment_fts, rowid, text)
         VALUES ('delete', old.rowid, old.text);
       END`,
    ],
  },
  {
    version: 2,
    statements: [
      // When the audio was recorded, as opposed to when laud was told about
      // it. Nullable on purpose: most containers carry no such tag, and a
      // column that always held a value would make "we know" and "we
      // guessed" indistinguishable. Callers resolve the fallback with
      // recordedOrImportedAt.
      `ALTER TABLE recording ADD COLUMN recorded_at TEXT`,
    ],
  },
  {
    version: 3,
    statements: [
      // Real names for the labels a diarizer invents. Kept in their own
      // table rather than written over segment.speaker: the label is what
      // the diarizer produced and must survive re-transcription, while the
      // name is a human's annotation of it. Overwriting one with the other
      // would lose the ability to re-run diarization without losing the
      // names, and lose the names on the next --force.
      `CREATE TABLE speaker (
         recording_id TEXT NOT NULL REFERENCES recording(id) ON DELETE CASCADE,
         label TEXT NOT NULL,
         name TEXT NOT NULL,
         PRIMARY KEY (recording_id, label)
       )`,
    ],
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function pendingMigrations(currentVersion: number): readonly Migration[] {
  if (currentVersion > SCHEMA_VERSION) {
    throw new Error(
      `The database is at schema version ${currentVersion}, newer than this build understands (${SCHEMA_VERSION}). Update laud.`,
    );
  }
  return MIGRATIONS.filter((m) => m.version > currentVersion);
}
