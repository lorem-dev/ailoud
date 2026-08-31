import { describe, expect, it } from 'vitest';
import type { DetectedTurn } from './bySpeaker.js';
import { resolveBySpeaker } from './bySpeaker.js';

const turn = (startMs: number, endMs: number, speaker: string, language: string): DetectedTurn => ({
  startMs,
  endMs,
  speaker,
  language,
});

describe('resolveBySpeaker', () => {
  it('gives every turn of a speaker the language they mostly spoke', () => {
    // The real shape: each speaker holds one language, and one short turn of
    // theirs was mis-detected. Pooling overrules it.
    const turns = [
      turn(0, 3000, 'speaker_00', 'en'),
      turn(3000, 5000, 'speaker_01', 'ru'),
      turn(5000, 8000, 'speaker_00', 'en'),
      turn(8000, 9000, 'speaker_01', 'pl'),
      turn(9000, 12_000, 'speaker_01', 'ru'),
    ];
    expect(resolveBySpeaker(turns, []).map((s) => s.language)).toEqual([
      'en',
      'ru',
      'en',
      'ru',
      'ru',
    ]);
  });

  it('weights the vote by duration, not by turn count', () => {
    // Three slivers against one long turn: counting turns would say ru,
    // counting speech says en. The long turn is the one the detector could
    // actually hear.
    const turns = [
      turn(0, 10_000, 'speaker_00', 'en'),
      turn(10_000, 10_500, 'speaker_00', 'ru'),
      turn(10_500, 11_000, 'speaker_00', 'ru'),
      turn(11_000, 11_500, 'speaker_00', 'ru'),
    ];
    expect(resolveBySpeaker(turns, []).every((s) => s.language === 'en')).toBe(true);
  });

  it('excludes an out-of-set detection from the vote entirely', () => {
    // pl is impossible per the declared set, so it must not even compete --
    // here it would otherwise outweigh the single in-set turn.
    const turns = [turn(0, 9000, 'speaker_00', 'pl'), turn(9000, 11_000, 'speaker_00', 'ru')];
    expect(resolveBySpeaker(turns, ['ru', 'en']).every((s) => s.language === 'ru')).toBe(true);
  });

  it('falls back to the first declared language for a speaker with no eligible turn', () => {
    const turns = [turn(0, 5000, 'speaker_00', 'pl'), turn(5000, 9000, 'speaker_00', 'uk')];
    expect(resolveBySpeaker(turns, ['ru', 'en']).every((s) => s.language === 'ru')).toBe(true);
  });

  it('keeps speakers independent of each other', () => {
    const turns = [
      turn(0, 5000, 'speaker_00', 'en'),
      turn(5000, 10_000, 'speaker_01', 'ru'),
      turn(10_000, 11_000, 'speaker_00', 'ru'),
      turn(11_000, 12_000, 'speaker_01', 'en'),
    ];
    // Each speaker's minority turn is overruled by their own majority, not by
    // the other speaker's.
    expect(resolveBySpeaker(turns, []).map((s) => s.language)).toEqual(['en', 'ru', 'en', 'ru']);
  });

  it('breaks an exact weight tie toward the language seen first', () => {
    const turns = [turn(0, 5000, 'speaker_00', 'en'), turn(5000, 10_000, 'speaker_00', 'ru')];
    expect(resolveBySpeaker(turns, []).every((s) => s.language === 'en')).toBe(true);
  });

  it('does not let a negative-duration turn subtract weight and flip the vote', () => {
    const turns = [
      turn(0, 6000, 'speaker_00', 'en'),
      turn(6000, 1000, 'speaker_00', 'en'),
      turn(6000, 9000, 'speaker_00', 'ru'),
    ];
    expect(resolveBySpeaker(turns, []).every((s) => s.language === 'en')).toBe(true);
  });

  it('drops the speaker label, since runs are about language not people', () => {
    const [first] = resolveBySpeaker([turn(0, 1000, 'speaker_00', 'en')], []);
    expect(first).toEqual({ startMs: 0, endMs: 1000, language: 'en' });
  });

  it('returns nothing for no turns', () => {
    expect(resolveBySpeaker([], ['ru'])).toEqual([]);
  });
});
