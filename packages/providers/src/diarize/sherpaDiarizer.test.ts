import { describe, expect, it } from 'vitest';
import { parseSpeakerTurns, SherpaDiarizer } from './sherpaDiarizer.js';

// Real output shape, captured from sherpa-onnx v1.13.6 on a two-speaker file.
const REAL_OUTPUT = [
  'Started',
  '1.583 -- 3.406 speaker_00',
  '4.402 -- 6.460 speaker_00',
  '9.346 -- 11.472 speaker_01',
  '12.164 -- 14.645 speaker_01',
].join('\n');

describe('parseSpeakerTurns', () => {
  it('parses real output into milliseconds', () => {
    expect(parseSpeakerTurns(REAL_OUTPUT)).toEqual([
      { startMs: 1583, endMs: 3406, speaker: 'speaker_00' },
      { startMs: 4402, endMs: 6460, speaker: 'speaker_00' },
      { startMs: 9346, endMs: 11472, speaker: 'speaker_01' },
      { startMs: 12164, endMs: 14645, speaker: 'speaker_01' },
    ]);
  });

  it('ignores the banner and any other chatter', () => {
    const noisy = ['Started', 'some log line', '0.500 -- 1.000 speaker_00', 'done'].join('\n');
    expect(parseSpeakerTurns(noisy)).toEqual([
      { startMs: 500, endMs: 1000, speaker: 'speaker_00' },
    ]);
  });

  it('handles a speaker index above nine', () => {
    expect(parseSpeakerTurns('0.000 -- 1.000 speaker_12')).toEqual([
      { startMs: 0, endMs: 1000, speaker: 'speaker_12' },
    ]);
  });

  it('returns nothing for empty output rather than throwing', () => {
    expect(parseSpeakerTurns('')).toEqual([]);
  });
});

describe('SherpaDiarizer', () => {
  it('passes the speaker count instead of the threshold when one is given', async () => {
    let seen: readonly string[] = [];
    const runner = async (_c: string, args: readonly string[]) => {
      seen = args;
      return { code: 0, stdout: '', stderr: '' };
    };
    const d = new SherpaDiarizer({
      binary: 'b',
      segmentationModel: 's',
      embeddingModel: 'e',
      threshold: 0.6,
      runner: runner as never,
    });
    await d.turns('a.wav', { speakers: 3 });
    expect(seen.join(' ')).toContain('--clustering.num-clusters=3');
    expect(seen.join(' ')).not.toContain('cluster-threshold');
  });

  it('passes the configured threshold instead of a count when none is given', async () => {
    let seen: readonly string[] = [];
    const runner = async (_c: string, args: readonly string[]) => {
      seen = args;
      return { code: 0, stdout: '', stderr: '' };
    };
    const d = new SherpaDiarizer({
      binary: 'b',
      segmentationModel: 's',
      embeddingModel: 'e',
      threshold: 0.6,
      runner: runner as never,
    });
    await d.turns('a.wav');
    expect(seen.join(' ')).toContain('--clustering.cluster-threshold=0.6');
    expect(seen.join(' ')).not.toContain('num-clusters');
  });

  it('turns a non-zero exit into a FailureError naming the stderr', async () => {
    const d = new SherpaDiarizer({
      binary: 'b',
      segmentationModel: 's',
      embeddingModel: 'e',
      threshold: 0.6,
      runner: (async () => ({ code: 2, stdout: '', stderr: 'bad model' })) as never,
    });
    await expect(d.turns('a.wav')).rejects.toThrow(/bad model/);
  });
});
