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
  return segments.map((segment) => {
    let best: string | undefined;
    let bestOverlap = 0;
    for (const turn of turns) {
      const shared = overlapMs(segment.startMs, segment.endMs, turn.startMs, turn.endMs);
      // Strictly greater: an exact tie keeps the earlier turn, so the result
      // does not depend on the order the diarizer happened to emit.
      if (shared > bestOverlap) {
        bestOverlap = shared;
        best = turn.speaker;
      }
    }
    return best === undefined ? segment : { ...segment, speaker: best };
  });
}
