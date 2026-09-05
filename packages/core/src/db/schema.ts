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
  {
    version: 4,
    statements: [
      // Free-form labels for grouping recordings. A table rather than a
      // column of comma-separated text, so "everything tagged standup" is a
      // query rather than a scan-and-split, and so a tag containing a comma
      // is not a parsing problem waiting to happen.
      `CREATE TABLE tag (
         recording_id TEXT NOT NULL REFERENCES recording(id) ON DELETE CASCADE,
         tag TEXT NOT NULL,
         PRIMARY KEY (recording_id, tag)
       )`,
      `CREATE INDEX tag_by_name ON tag(tag)`,
    ],
  },
  {
    version: 5,
    statements: [
      // A summary is not a property of a recording: one can cover several, and
      // the same recording can be summarised again in another language or by
      // another model without the earlier one becoming wrong. So it is its own
      // row, with the recordings it covers in a join table.
      //
      // The model and language are stored because they explain the text. A
      // summary reused later as context is worth less if nobody can tell
      // whether haiku or opus wrote it, or which language it came out in.
      `CREATE TABLE summary (
         id TEXT PRIMARY KEY,
         created_at TEXT NOT NULL,
         language TEXT NOT NULL,
         provider TEXT NOT NULL,
         model TEXT NOT NULL,
         body TEXT NOT NULL
       )`,
      `CREATE TABLE summary_recording (
         summary_id TEXT NOT NULL REFERENCES summary(id) ON DELETE CASCADE,
         recording_id TEXT NOT NULL REFERENCES recording(id) ON DELETE CASCADE,
         PRIMARY KEY (summary_id, recording_id)
       )`,
      // The lookup this exists for: "the newest summary of this recording",
      // asked once per recording when a group summary reuses them.
      `CREATE INDEX summary_by_recording ON summary_recording(recording_id)`,
    ],
  },
  {
    version: 6,
    statements: [
      // What shaped the report, beyond which model wrote it: the template
      // decides its headings, and the caller's context is the one thing the
      // model knew that the transcript does not say. Stored for the same
      // reason `model` is -- a report reused later as context is worth less if
      // nobody can tell what it was asked to be.
      `ALTER TABLE summary ADD COLUMN template TEXT NOT NULL DEFAULT 'meeting'`,
      `ALTER TABLE summary ADD COLUMN context TEXT NOT NULL DEFAULT ''`,
    ],
  },
  {
    version: 7,
    statements: [
      // segment_fts has existed since version 1, with insert and delete
      // triggers. An UPDATE trigger was missing, so a statement that rewrote a
      // segment's text in place would leave the index holding the old words:
      // search would find the recording by a phrase nobody says in it any
      // more, and miss it by the phrase they do. Nothing in laud updates
      // segment text today -- re-transcribing inserts a new transcript -- so
      // this is closing a hole rather than fixing a symptom, which is the
      // cheapest time to do it.
      `CREATE TRIGGER segment_fts_update AFTER UPDATE ON segment BEGIN
         INSERT INTO segment_fts(segment_fts, rowid, text)
         VALUES ('delete', old.rowid, old.text);
         INSERT INTO segment_fts(rowid, text) VALUES (new.rowid, new.text);
       END`,
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
