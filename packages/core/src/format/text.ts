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
): string =>
  segments
    .map((s) => {
      // Only diarized segments carry a speaker; everyone else must render
      // byte-identical to before diarization existed (see subtitles.test.ts).
      const shown = speakerDisplayName(s.speaker, names);
      const speakerPrefix = shown === null ? '' : `${shown}: `;
      return `[${formatTimestamp(s.startMs, 'short')}] ${speakerPrefix}${s.text}\n`;
    })
    .join('');
