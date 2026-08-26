import type { Segment } from '../domain/model.js';
import { formatTimestamp } from './subtitles.js';

export const toPlainText = (segments: readonly Segment[]): string =>
  segments.map((s) => `[${formatTimestamp(s.startMs, 'short')}] ${s.text}\n`).join('');
