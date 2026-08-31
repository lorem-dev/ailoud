import type { Segment } from '../domain/model.js';
import { formatTimestamp } from './subtitles.js';
import { speakerDisplayName } from '../transcribe/speakers.js';

/**
 * `names` maps diarizer labels to the names a human gave them. Empty by
 * default, so every existing caller keeps printing labels and nothing that
 * was not annotated changes shape.
 */
export const toPlainText = (
  segments: readonly Segment[],
  names: ReadonlyMap<string, string> = new Map(),
  /**
   * Applied to the speaker's name and nothing else -- not the timestamp, not
   * the words. The CLI passes a colouriser when it is writing to a terminal
   * and leaves this out otherwise, which is what keeps escape sequences out
   * of a redirected transcript. Core stays ignorant of terminals; it just
   * calls what it was handed.
   */
  decorateSpeaker: (name: string) => string = (name) => name,
): string => {
  // Every speaker's name is padded to the longest, so the words all begin in
  // the same column and the eye can run down them instead of stepping in and
  // out around "Andrew:" and "Donat:".
  //
  // Measured on the PLAIN name and padded before decorating: the decorator
  // wraps the name in escape sequences, and padding after it would count
  // those invisible bytes and under-indent every coloured line by exactly the
  // width of its colour code.
  //
  // Counted in code points rather than terminal columns. Core has no
  // width-measuring dependency and should not grow one for this; the
  // difference only shows for names in scripts whose characters occupy two
  // columns, and being a column out on a CJK name is a smaller problem than
  // core reaching for a display concern.
  const widest = segments.reduce((max, segment) => {
    const shown = speakerDisplayName(segment.speaker, names);
    return shown === null ? max : Math.max(max, Array.from(shown).length);
  }, 0);

  return segments
    .map((s) => {
      // Only diarized segments carry a speaker; everyone else must render
      // byte-identical to before diarization existed (see subtitles.test.ts).
      const shown = speakerDisplayName(s.speaker, names);
      const speakerPrefix =
        shown === null
          ? ''
          : `${decorateSpeaker(shown)}:${' '.repeat(widest - Array.from(shown).length + 1)}`;
      return `[${formatTimestamp(s.startMs, 'short')}] ${speakerPrefix}${s.text}\n`;
    })
    .join('');
};
