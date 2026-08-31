export interface Recording {
  readonly id: string;
  readonly sha256: string;
  readonly sourcePath: string;
  readonly mediaPath: string;
  readonly durationMs: number;
  readonly mime: string;
  readonly title: string | null;
  readonly notes: string | null;
  /**
   * When the audio was recorded, from the container's own metadata, or null
   * when it carries none -- which is most of the time for wav, and usual for
   * anything re-encoded.
   *
   * Kept separate from `importedAt` rather than folded into it: a date read
   * from the file is a fact about the recording, and the import timestamp is
   * a fact about laud. Storing only the resolved value would answer "when
   * was this recorded" with a number that might mean "when did I first see
   * it", with no way to tell which. Use `recordedOrImportedAt` to resolve.
   */
  readonly recordedAt: string | null;
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
