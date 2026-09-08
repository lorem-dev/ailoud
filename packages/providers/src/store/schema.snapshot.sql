CREATE INDEX summary_by_recording ON summary_recording(recording_id);

CREATE INDEX tag_by_name ON tag(tag);

CREATE INDEX transcript_by_recording ON transcript(recording_id, created_at DESC);

CREATE TABLE recording (
         id TEXT PRIMARY KEY,
         sha256 TEXT NOT NULL UNIQUE,
         source_path TEXT NOT NULL,
         media_path TEXT NOT NULL,
         duration_ms INTEGER NOT NULL,
         mime TEXT NOT NULL,
         title TEXT,
         notes TEXT,
         imported_at TEXT NOT NULL
       , recorded_at TEXT);

CREATE TABLE segment (
         id TEXT PRIMARY KEY,
         transcript_id TEXT NOT NULL REFERENCES transcript(id) ON DELETE CASCADE,
         idx INTEGER NOT NULL,
         start_ms INTEGER NOT NULL,
         end_ms INTEGER NOT NULL,
         text TEXT NOT NULL,
         speaker TEXT,
         language TEXT,
         UNIQUE (transcript_id, idx)
       );

CREATE VIRTUAL TABLE segment_fts USING fts5(
         text, content='segment', content_rowid='rowid'
       );

CREATE TABLE speaker (
         recording_id TEXT NOT NULL REFERENCES recording(id) ON DELETE CASCADE,
         label TEXT NOT NULL,
         name TEXT NOT NULL,
         PRIMARY KEY (recording_id, label)
       );

CREATE TABLE summary (
         id TEXT PRIMARY KEY,
         created_at TEXT NOT NULL,
         language TEXT NOT NULL,
         provider TEXT NOT NULL,
         model TEXT NOT NULL,
         body TEXT NOT NULL
       , template TEXT NOT NULL DEFAULT 'meeting', context TEXT NOT NULL DEFAULT '');

CREATE TABLE summary_recording (
         summary_id TEXT NOT NULL REFERENCES summary(id) ON DELETE CASCADE,
         recording_id TEXT NOT NULL REFERENCES recording(id) ON DELETE CASCADE,
         PRIMARY KEY (summary_id, recording_id)
       );

CREATE TABLE tag (
         recording_id TEXT NOT NULL REFERENCES recording(id) ON DELETE CASCADE,
         tag TEXT NOT NULL,
         PRIMARY KEY (recording_id, tag)
       );

CREATE TABLE transcript (
         id TEXT PRIMARY KEY,
         recording_id TEXT NOT NULL REFERENCES recording(id) ON DELETE CASCADE,
         provider TEXT NOT NULL,
         model TEXT NOT NULL,
         language TEXT NOT NULL,
         text TEXT NOT NULL,
         created_at TEXT NOT NULL
       );

CREATE TRIGGER segment_ad AFTER DELETE ON segment BEGIN
         INSERT INTO segment_fts(segment_fts, rowid, text)
         VALUES ('delete', old.rowid, old.text);
       END;

CREATE TRIGGER segment_ai AFTER INSERT ON segment BEGIN
         INSERT INTO segment_fts(rowid, text) VALUES (new.rowid, new.text);
       END;

CREATE TRIGGER segment_fts_update AFTER UPDATE ON segment BEGIN
         INSERT INTO segment_fts(segment_fts, rowid, text)
         VALUES ('delete', old.rowid, old.text);
         INSERT INTO segment_fts(rowid, text) VALUES (new.rowid, new.text);
       END;
