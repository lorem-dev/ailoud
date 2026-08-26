import type { Segment } from '../domain/model.js';

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

export function formatTimestamp(ms: number, style: 'srt' | 'vtt' | 'short'): string {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  const clock = `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}`;
  if (style === 'short') return clock;
  const millis = pad(ms % 1000, 3);
  return style === 'srt' ? `${clock},${millis}` : `${clock}.${millis}`;
}

const cues = (segments: readonly Segment[], style: 'srt' | 'vtt'): string =>
  segments
    .map(
      (s, i) =>
        `${style === 'srt' ? `${i + 1}\n` : ''}` +
        `${formatTimestamp(s.startMs, style)} --> ${formatTimestamp(s.endMs, style)}\n` +
        `${s.text}\n`,
    )
    .join('\n');

export const toSrt = (segments: readonly Segment[]): string => cues(segments, 'srt');
export const toVtt = (segments: readonly Segment[]): string => `WEBVTT\n\n${cues(segments, 'vtt')}`;
