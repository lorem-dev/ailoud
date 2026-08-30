import type { RawSegment } from '../domain/model.js';
import type { SpeakerTurn } from '../domain/ports.js';

/** Milliseconds two spans share. Zero when they do not touch. */
function overlapMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/**
 * Attributes each transcript segment to a speaker by time overlap.
 *
 * This is the join between two independent views of the same recording:
 * diarization produces speaker turns, transcription produces text segments,
 * and neither knows the other exists. Keeping the join here -- pure
 * arithmetic over two lists of spans -- is what lets `--diarize` and
 * `--multilingual` compose without either feature entangling the other.
 *
 * A segment overlapping no turn keeps no speaker rather than being forced
 * onto the nearest one. Silence, music, and a diarizer that simply missed a
 * region are all real, and inventing an attribution for them would put a
 * name against words nobody was shown to have said.
 */
export function assignSpeakers(
  segments: readonly RawSegment[],
  turns: readonly SpeakerTurn[],
): RawSegment[] {
  // Sorted by startMs so the tie-break below is a fact about this function,
  // not a favour the caller has to remember to do. `Diarizer.turns` documents
  // "timeline order", but that promise lives on a different type with
  // nothing to enforce it; a parser feeding this from a binary's stdout could
  // get it wrong without either type noticing. Copy first: the caller's array
  // is not ours to reorder.
  const orderedTurns = [...turns].sort((a, b) => a.startMs - b.startMs);
  return segments.map((segment) => {
    let best: string | undefined;
    let bestOverlap = 0;
    for (const turn of orderedTurns) {
      const shared = overlapMs(segment.startMs, segment.endMs, turn.startMs, turn.endMs);
      // Strictly greater: an exact tie keeps whichever turn sorted first,
      // i.e. the earlier one, regardless of the order the diarizer emitted.
      if (shared > bestOverlap) {
        bestOverlap = shared;
        best = turn.speaker;
      }
    }
    return best === undefined ? segment : { ...segment, speaker: best };
  });
}
