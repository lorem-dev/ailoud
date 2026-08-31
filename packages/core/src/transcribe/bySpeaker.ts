import type { SpeakerTurn } from '../domain/ports.js';
import type { DetectedSpan } from './merge.js';

/** A speaker turn with the language detection reported for it. */
export interface DetectedTurn extends SpeakerTurn {
  readonly language: string;
}

/**
 * Decides each speaker's language from all of their turns, then applies it to
 * every turn of theirs.
 *
 * This exists because fixed-size windows cannot satisfy both halves of the
 * problem at once. Language detection needs roughly five seconds of one
 * language to be reliable; conversational turns last two to four. A window
 * wide enough to detect reliably straddles turns and swallows the shorter
 * language whole; a window narrow enough to follow the conversation detects
 * badly. Measured on a 32-second bilingual conversation, the wide setting
 * lost five of six English turns and the narrow one clipped phrase edges.
 *
 * Speaker turns dissolve that trade rather than splitting it. They are the
 * boundaries language actually changes on in a bilingual exchange, so they
 * need no widening to be accurate -- and pooling a speaker's turns gives the
 * detector far more than five seconds to judge by even when each individual
 * turn is short. In that same conversation each speaker held about sixteen
 * seconds spread over six two-second turns.
 *
 * Votes are weighted by duration: a five-second turn's detection is better
 * evidence than a one-second turn's, and counting them equally would let a
 * pile of sliver turns outvote the speech that was actually intelligible.
 *
 * When `declared` is non-empty, detections outside it are excluded from the
 * vote entirely -- an answer the caller has said is impossible should not get
 * to influence the outcome, only to be overruled by it. A speaker whose every
 * detection was out of set has no vote of their own and takes the first
 * declared language, which is the same fallback `resolveDeclaredLanguages`
 * uses for an un-anchored recording.
 *
 * The cost, stated plainly: this assumes one language per speaker for the
 * duration of a recording. That is the common shape of a bilingual
 * conversation -- each person speaks their own language -- but a single
 * speaker who genuinely switches mid-recording will be flattened to whichever
 * language they used more. Callers who expect that should not declare a
 * diarizer for segmentation.
 */
export function resolveBySpeaker(
  turns: readonly DetectedTurn[],
  declared: readonly string[],
): DetectedSpan[] {
  const allowed = new Set(declared);
  const eligible = (language: string): boolean => declared.length === 0 || allowed.has(language);

  const weightBySpeaker = new Map<string, Map<string, number>>();
  for (const turn of turns) {
    if (!eligible(turn.language)) continue;
    const byLanguage = weightBySpeaker.get(turn.speaker) ?? new Map<string, number>();
    // Clamp: a provider reporting an end before its start must not subtract
    // weight from a language and flip the vote.
    const weight = Math.max(0, turn.endMs - turn.startMs);
    byLanguage.set(turn.language, (byLanguage.get(turn.language) ?? 0) + weight);
    weightBySpeaker.set(turn.speaker, byLanguage);
  }

  const languageBySpeaker = new Map<string, string>();
  for (const [speaker, byLanguage] of weightBySpeaker) {
    let best: string | undefined;
    let bestWeight = -1;
    for (const [language, weight] of byLanguage) {
      // Strictly greater, so a tie keeps the language seen first and the
      // result does not depend on Map iteration happening to reorder.
      if (weight > bestWeight) {
        bestWeight = weight;
        best = language;
      }
    }
    if (best !== undefined) languageBySpeaker.set(speaker, best);
  }

  return turns.map((turn) => ({
    startMs: turn.startMs,
    endMs: turn.endMs,
    language: languageBySpeaker.get(turn.speaker) ?? declared[0] ?? turn.language,
  }));
}
