import { describe, expect, it } from 'vitest';
import {
  clampMonotonic,
  multilingualStages,
  singlePassStages,
  stageScale,
  weightedOverall,
} from './scale.js';

describe('stageScale', () => {
  const scale = stageScale([
    { name: 'a', weight: 2 },
    { name: 'b', weight: 8 },
  ]);

  it('places the start of the first stage at zero', () => {
    expect(scale('a', 0)).toBe(0);
  });

  it('places the end of the last stage at one', () => {
    expect(scale('b', 1)).toBe(1);
  });

  it('offsets a stage by the weight of everything before it', () => {
    expect(scale('b', 0)).toBeCloseTo(0.2);
    expect(scale('b', 0.5)).toBeCloseTo(0.6);
  });

  it('normalises across whatever weights it was given', () => {
    const uneven = stageScale([
      { name: 'x', weight: 1 },
      { name: 'y', weight: 3 },
    ]);
    expect(uneven('y', 0)).toBeCloseTo(0.25);
  });

  it('clamps a within-stage fraction outside 0..1', () => {
    expect(scale('a', -1)).toBe(0);
    expect(scale('a', 5)).toBeCloseTo(0.2);
  });

  it('returns 0 for a stage it does not know, rather than throwing', () => {
    expect(scale('nope', 0.5)).toBe(0);
  });

  it('returns 0 for an empty stage list, rather than dividing by zero', () => {
    expect(stageScale([])('a', 0.5)).toBe(0);
  });
});

describe('clampMonotonic', () => {
  it('takes the larger of the two', () => {
    expect(clampMonotonic(0.4, 0.6)).toBe(0.6);
  });

  it('refuses to go backwards', () => {
    expect(clampMonotonic(0.6, 0.4)).toBe(0.6);
  });

  it('bounds the result to 0..1', () => {
    expect(clampMonotonic(0, -1)).toBe(0);
    expect(clampMonotonic(0, 5)).toBe(1);
  });

  it('treats a non-finite next value as no news', () => {
    expect(clampMonotonic(0.5, Number.NaN)).toBe(0.5);
  });
});

describe('weightedOverall', () => {
  it('weights by duration, not by count', () => {
    // Four short recordings and one long one: finishing the four is not 80%.
    const durations = [1000, 1000, 1000, 1000, 16_000];
    expect(weightedOverall(durations, 4, 0)).toBeCloseTo(0.2);
  });

  it('interpolates within the current recording', () => {
    expect(weightedOverall([1000, 1000], 0, 0.5)).toBeCloseTo(0.25);
  });

  it('reaches one at the end of the last recording', () => {
    expect(weightedOverall([1000, 3000], 1, 1)).toBe(1);
  });

  it('falls back to counting when no duration is known', () => {
    expect(weightedOverall([0, 0], 1, 0)).toBeCloseTo(0.5);
  });

  it('returns 0 for an empty list rather than dividing by zero', () => {
    expect(weightedOverall([], 0, 0.5)).toBe(0);
  });

  it('ignores an out-of-range index rather than throwing', () => {
    expect(weightedOverall([1000], 7, 0.5)).toBe(1);
  });
});

describe('singlePassStages', () => {
  it('leaves no gap when diarization is off', () => {
    const stages = singlePassStages(false);
    expect(stages.map((s) => s.name)).toEqual(['converting', 'transcribing']);
    expect(stageScale(stages)('transcribing', 1)).toBe(1);
  });

  it('reserves a slice for diarization when it is on', () => {
    const stages = singlePassStages(true);
    expect(stages.map((s) => s.name)).toEqual(['converting', 'transcribing', 'diarizing']);
    expect(stageScale(stages)('transcribing', 1)).toBeCloseTo(0.92);
  });
});

describe('multilingualStages', () => {
  it('grows the detection stage with the number of units', () => {
    const few = multilingualStages({ unitCount: 4, audioSeconds: 600, diarize: false });
    const many = multilingualStages({ unitCount: 90, audioSeconds: 600, diarize: false });
    const weightOf = (stages: readonly { name: string; weight: number }[], name: string) =>
      stages.find((s) => s.name === name)?.weight ?? 0;
    expect(weightOf(many, 'detecting')).toBeGreaterThan(weightOf(few, 'detecting'));
  });

  it('gives detection the larger share when detections outnumber the audio', () => {
    // 40 model loads against 60 seconds of audio: detection dominates, and a
    // fixed 20/70 split would park the bar at 20% for most of the run.
    const stages = multilingualStages({ unitCount: 40, audioSeconds: 60, diarize: false });
    const scale = stageScale(stages);
    expect(scale('transcribing', 0) - scale('detecting', 0)).toBeGreaterThan(0.5);
  });

  it('never gives a stage a zero weight, so no stage is unreachable', () => {
    const stages = multilingualStages({ unitCount: 0, audioSeconds: 0, diarize: true });
    for (const stage of stages) expect(stage.weight).toBeGreaterThan(0);
  });

  it('ends on transcribing when diarization is off', () => {
    const stages = multilingualStages({ unitCount: 4, audioSeconds: 600, diarize: false });
    expect(stageScale(stages)('transcribing', 1)).toBe(1);
  });

  it('ends on labelling when diarization is on, because labels come after the words', () => {
    // withSpeakers runs after the transcription loop in transcribeMultilingual:
    // segments must exist before a speaker can be attributed to them. So
    // `transcribing` finishing is NOT the run finishing.
    const stages = multilingualStages({ unitCount: 4, audioSeconds: 600, diarize: true });
    const scale = stageScale(stages);
    expect(scale('labelling', 1)).toBe(1);
    expect(scale('transcribing', 1)).toBeLessThan(1);
  });
});
