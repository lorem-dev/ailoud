import { describe, expect, it } from 'vitest';
import type { RawSegment } from '../domain/model.js';
import type { SpeakerTurn } from '../domain/ports.js';
import { assignSpeakers } from './assign.js';

const seg = (startMs: number, endMs: number): RawSegment => ({ startMs, endMs, text: 'x' });
const turn = (startMs: number, endMs: number, speaker: string): SpeakerTurn => ({
  startMs,
  endMs,
  speaker,
});

describe('assignSpeakers', () => {
  it('gives a segment the speaker whose turn contains it', () => {
    const out = assignSpeakers([seg(1000, 2000)], [turn(0, 3000, 'speaker_00')]);
    expect(out[0]?.speaker).toBe('speaker_00');
  });

  it('gives a segment straddling two turns the one it overlaps most', () => {
    // 1200 ms in speaker_00, 800 ms in speaker_01.
    const turns = [turn(0, 2200, 'speaker_00'), turn(2200, 4000, 'speaker_01')];
    const out = assignSpeakers([seg(1000, 3000)], turns);
    expect(out[0]?.speaker).toBe('speaker_00');
  });

  it('leaves a segment overlapping nothing without a speaker', () => {
    const out = assignSpeakers([seg(5000, 6000)], [turn(0, 1000, 'speaker_00')]);
    expect(out[0]?.speaker).toBeUndefined();
  });

  it('leaves every segment alone when there are no turns at all', () => {
    // A diarizer that found nothing must not blank out the transcript.
    const segments = [seg(0, 1000), seg(1000, 2000)];
    const out = assignSpeakers(segments, []);
    expect(out).toHaveLength(2);
    expect(out.every((s) => s.speaker === undefined)).toBe(true);
    expect(out.map((s) => s.text)).toEqual(['x', 'x']);
  });

  it('preserves every other field of the segment untouched', () => {
    const input: RawSegment = { startMs: 0, endMs: 1000, text: 'hello', language: 'en' };
    const out = assignSpeakers([input], [turn(0, 1000, 'speaker_00')]);
    expect(out[0]).toEqual({ ...input, speaker: 'speaker_00' });
  });

  it('handles turns that do not cover the whole recording', () => {
    const turns = [turn(0, 1000, 'speaker_00'), turn(5000, 6000, 'speaker_01')];
    const out = assignSpeakers([seg(0, 500), seg(2000, 3000), seg(5200, 5800)], turns);
    expect(out.map((s) => s.speaker)).toEqual(['speaker_00', undefined, 'speaker_01']);
  });

  it('breaks an exact overlap tie by the earlier turn, deterministically', () => {
    const turns = [turn(0, 1000, 'speaker_00'), turn(1000, 2000, 'speaker_01')];
    // 500 ms in each.
    const out = assignSpeakers([seg(500, 1500)], turns);
    expect(out[0]?.speaker).toBe('speaker_00');
  });

  it('ignores a zero-length turn rather than letting it win a tie', () => {
    const turns = [turn(1000, 1000, 'speaker_09'), turn(0, 2000, 'speaker_00')];
    const out = assignSpeakers([seg(900, 1100)], turns);
    expect(out[0]?.speaker).toBe('speaker_00');
  });
});
