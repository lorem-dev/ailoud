import type { Segment } from '../domain/model.js';
import { formatTimestamp } from './subtitles.js';

export const toPlainText = (segments: readonly Segment[]): string =>
  segments
    .map((s) => {
      // Only diarized segments carry a speaker; everyone else must render
      // byte-identical to before diarization existed (see subtitles.test.ts).
      const speakerPrefix = s.speaker === null ? '' : `${s.speaker}: `;
      return `[${formatTimestamp(s.startMs, 'short')}] ${speakerPrefix}${s.text}\n`;
    })
    .join('');
