export interface Recording {
  readonly id: string;
  readonly sha256: string;
  readonly sourcePath: string;
  readonly mediaPath: string;
  readonly durationMs: number;
  readonly mime: string;
  readonly title: string | null;
  readonly notes: string | null;
  readonly importedAt: string;
}

export interface Transcript {
  readonly id: string;
  readonly recordingId: string;
  readonly provider: string;
  readonly model: string;
  readonly language: string;
  readonly text: string;
  readonly createdAt: string;
}

export interface Segment {
  readonly id: string;
  readonly transcriptId: string;
  readonly idx: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly speaker: string | null;
  readonly language: string | null;
}

/** What a transcription provider returns, before it is given ids and stored. */
export interface RawSegment {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly speaker?: string;
  readonly language?: string;
}
