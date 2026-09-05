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

/**
 * A summary someone asked for and kept.
 *
 * Not a field on the recording: one summary can cover several recordings, and
 * the same recording can be summarised again in another language or by another
 * model without the earlier one becoming wrong. `provider` and `model` are
 * kept because they explain the text -- a summary later reused as context is
 * worth less if nobody can tell what wrote it.
 */
export interface Summary {
  readonly id: string;
  readonly createdAt: string;
  readonly language: string;
  readonly provider: string;
  readonly model: string;
  readonly body: string;
  /** Which template shaped its headings. */
  readonly template: string;
  /** The context the caller supplied, or empty. */
  readonly context: string;
  /** The recordings it covers, in id order. */
  readonly recordingIds: readonly string[];
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

/**
 * A human's name for one of the labels a diarizer produced.
 *
 * `label` is what the diarizer said ("speaker_00"); `name` is who that
 * actually is. The pair lives per recording, because the same label means a
 * different person in a different file.
 */
export interface SpeakerName {
  readonly label: string;
  readonly name: string;
}

/** What a transcription provider returns, before it is given ids and stored. */
export interface RawSegment {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly speaker?: string;
  readonly language?: string;
}
