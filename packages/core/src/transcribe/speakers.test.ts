import { describe, expect, it } from 'vitest';
import type { Segment, SpeakerName } from '../domain/model.js';
import {
  segmentsOfSpeaker,
  speakerDisplayName,
  speakerNameMap,
  summarizeSpeakers,
} from './speakers.js';

const seg = (startMs: number, endMs: number, speaker: string | null, text = 'x'): Segment => ({
  id: `s-${startMs}`,
  transcriptId: 'T1',
  idx: startMs,
  startMs,
  endMs,
  text,
  speaker,
  language: null,
});

const named = (label: string, name: string): SpeakerName => ({ label, name });

describe('speakerDisplayName', () => {
  it('prefers a name over the label', () => {
    expect(speakerDisplayName('speaker_00', speakerNameMap([named('speaker_00', 'Ann')]))).toBe(
      'Ann',
    );
  });

  it('falls back to the label when nobody has named it', () => {
    expect(speakerDisplayName('speaker_00', new Map())).toBe('speaker_00');
  });

  it('passes a missing speaker through as missing', () => {
    // A segment from a non-diarized transcript has no speaker at all, and
    // must not acquire one here.
    expect(speakerDisplayName(null, speakerNameMap([named('speaker_00', 'Ann')]))).toBeNull();
  });
});

describe('summarizeSpeakers', () => {
  it('counts segments and sums speech per speaker', () => {
    const summary = summarizeSpeakers(
      [seg(0, 2000, 'speaker_00'), seg(2000, 3000, 'speaker_01'), seg(3000, 5000, 'speaker_00')],
      [],
    );
    expect(summary).toEqual([
      { label: 'speaker_00', name: null, segmentCount: 2, spokenMs: 4000 },
      { label: 'speaker_01', name: null, segmentCount: 1, spokenMs: 1000 },
    ]);
  });

  it('orders by who spoke most, not by label', () => {
    // "Who did most of the talking" is the question a reader has; label order
    // answers a different one.
    const summary = summarizeSpeakers(
      [seg(0, 1000, 'speaker_00'), seg(1000, 9000, 'speaker_01')],
      [],
    );
    expect(summary.map((s) => s.label)).toEqual(['speaker_01', 'speaker_00']);
  });

  it('attaches the names a human gave', () => {
    const summary = summarizeSpeakers([seg(0, 1000, 'speaker_00')], [named('speaker_00', 'Ann')]);
    expect(summary[0]?.name).toBe('Ann');
  });

  it('shows a named speaker no segment mentions, rather than hiding it', () => {
    // A name left over from a diarization run whose labels have since changed
    // is exactly the evidence a reader needs to understand why their
    // annotation stopped taking effect.
    const summary = summarizeSpeakers([seg(0, 1000, 'speaker_00')], [named('speaker_09', 'Ghost')]);
    expect(summary).toContainEqual({
      label: 'speaker_09',
      name: 'Ghost',
      segmentCount: 0,
      spokenMs: 0,
    });
  });

  it('ignores segments with no speaker', () => {
    expect(summarizeSpeakers([seg(0, 1000, null)], [])).toEqual([]);
  });

  it('does not let a negative-duration segment reorder the summary', () => {
    const summary = summarizeSpeakers(
      [seg(0, 5000, 'speaker_00'), seg(5000, 1000, 'speaker_00'), seg(5000, 8000, 'speaker_01')],
      [],
    );
    expect(summary[0]?.label).toBe('speaker_00');
  });

  it('breaks a tie by label so the order is stable', () => {
    const summary = summarizeSpeakers(
      [seg(0, 1000, 'speaker_01'), seg(1000, 2000, 'speaker_00')],
      [],
    );
    expect(summary.map((s) => s.label)).toEqual(['speaker_00', 'speaker_01']);
  });
});

describe('segmentsOfSpeaker', () => {
  const segments = [
    seg(0, 1000, 'speaker_00', 'first'),
    seg(1000, 2000, 'speaker_01', 'second'),
    seg(2000, 3000, 'speaker_00', 'third'),
  ];

  it('selects by diarizer label', () => {
    expect(segmentsOfSpeaker(segments, [], 'speaker_00').map((s) => s.text)).toEqual([
      'first',
      'third',
    ]);
  });

  it('selects by the name a human gave, which is what they just read', () => {
    const names = [named('speaker_01', 'Ann')];
    expect(segmentsOfSpeaker(segments, names, 'Ann').map((s) => s.text)).toEqual(['second']);
  });

  it('does not care about case, for the same reason id prefixes do not', () => {
    const names = [named('speaker_01', 'Ann')];
    expect(segmentsOfSpeaker(segments, names, 'ann')).toHaveLength(1);
    expect(segmentsOfSpeaker(segments, [], 'SPEAKER_00')).toHaveLength(2);
  });

  it('returns nothing for a speaker who is not there', () => {
    expect(segmentsOfSpeaker(segments, [], 'speaker_09')).toEqual([]);
  });

  it('never matches a segment with no speaker', () => {
    expect(segmentsOfSpeaker([seg(0, 1000, null)], [], 'speaker_00')).toEqual([]);
  });
});
