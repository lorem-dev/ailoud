import { describe, expect, it } from 'vitest';
import type { Segment } from '../domain/model.js';
import { formatTimestamp, toSrt, toVtt } from './subtitles.js';
import { toPlainText } from './text.js';

const segments: Segment[] = [
  {
    id: 'S1',
    transcriptId: 'T1',
    idx: 0,
    startMs: 0,
    endMs: 1500,
    text: 'Hello there',
    speaker: null,
    language: null,
  },
  {
    id: 'S2',
    transcriptId: 'T1',
    idx: 1,
    startMs: 3_661_500,
    endMs: 3_663_000,
    text: 'General Kenobi',
    speaker: null,
    language: null,
  },
];

describe('formatTimestamp', () => {
  it('formats SRT timestamps with a comma', () => {
    expect(formatTimestamp(3_661_500, 'srt')).toBe('01:01:01,500');
  });
  it('formats VTT timestamps with a period', () => {
    expect(formatTimestamp(3_661_500, 'vtt')).toBe('01:01:01.500');
  });
  it('pads a zero timestamp', () => {
    expect(formatTimestamp(0, 'srt')).toBe('00:00:00,000');
  });
});

describe('toSrt', () => {
  it('numbers cues from one', () => {
    expect(toSrt(segments)).toBe(
      '1\n00:00:00,000 --> 00:00:01,500\nHello there\n\n' +
        '2\n01:01:01,500 --> 01:01:03,000\nGeneral Kenobi\n',
    );
  });
});

describe('toVtt', () => {
  it('starts with the WEBVTT header', () => {
    expect(toVtt(segments).startsWith('WEBVTT\n\n')).toBe(true);
  });
});

describe('toPlainText', () => {
  it('prefixes each line with a bracketed timestamp', () => {
    expect(toPlainText(segments)).toBe('[00:00:00] Hello there\n[01:01:01] General Kenobi\n');
  });
});
