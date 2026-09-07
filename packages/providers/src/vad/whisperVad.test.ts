import { describe, expect, it, vi } from 'vitest';
import { parseVadSegments, WhisperVadSegmenter } from './whisperVad.js';

describe('parseVadSegments', () => {
  it('converts centisecond bounds into milliseconds', () => {
    // Centiseconds, per the tool's own help text. Getting this wrong scales
    // every timestamp by ten and is invisible until a transcript is read.
    const output = [
      'Detected 2 speech segments:',
      'Speech segment 0: start = 0.00, end = 253.00',
      'Speech segment 1: start = 359.00, end = 627.00',
    ].join('\n');
    expect(parseVadSegments(output)).toEqual([
      { startMs: 0, endMs: 2530 },
      { startMs: 3590, endMs: 6270 },
    ]);
  });

  it('ignores lines that are not segments', () => {
    const output = [
      'Detected 1 speech segments:',
      'Speech segment 0: start = 10.00, end = 20.00',
    ].join('\n');
    expect(parseVadSegments(output)).toEqual([{ startMs: 100, endMs: 200 }]);
  });

  it('returns nothing when the tool found no speech', () => {
    expect(parseVadSegments('Detected 0 speech segments:')).toEqual([]);
  });
});

describe('WhisperVadSegmenter', () => {
  it('passes the model and audio path, and converts the result to milliseconds', async () => {
    const runner = vi.fn(async () => ({
      code: 0,
      stdout: ['Detected 1 speech segments:', 'Speech segment 0: start = 0.00, end = 346.00'].join(
        '\n',
      ),
      stderr: '',
    }));
    const segmenter = new WhisperVadSegmenter({
      binary: 'whisper-vad-speech-segments',
      vadModelPath: '/models/vad.bin',
      threads: 4,
      runner,
    });

    const spans = await segmenter.segments('/tmp/a.wav');

    expect(runner).toHaveBeenCalledWith(
      'whisper-vad-speech-segments',
      ['-f', '/tmp/a.wav', '-vm', '/models/vad.bin', '-t', '4', '-np'],
      expect.anything(),
    );
    expect(spans).toEqual([{ startMs: 0, endMs: 3460 }]);
  });

  it('turns a non-zero exit into a failure naming the stderr', async () => {
    const segmenter = new WhisperVadSegmenter({
      binary: 'whisper-vad-speech-segments',
      vadModelPath: '/models/vad.bin',
      threads: 4,
      runner: async () => ({ code: 1, stdout: '', stderr: 'could not load vad model' }),
    });
    await expect(segmenter.segments('/tmp/a.wav')).rejects.toThrow(/could not load vad model/);
  });

  it('turns zero detected spans into a named failure rather than an empty list, without naming the (by-then-deleted) temp path', async () => {
    const segmenter = new WhisperVadSegmenter({
      binary: 'whisper-vad-speech-segments',
      vadModelPath: '/models/vad.bin',
      threads: 4,
      runner: async () => ({ code: 0, stdout: 'Detected 0 speech segments:', stderr: '' }),
    });
    await expect(segmenter.segments('/tmp/ailoud-xK9p2/audio.wav')).rejects.toThrow(
      'no speech found; transcribe it without --multilingual',
    );
  });
});

describe('resource flags', () => {
  it('passes the thread count it was given', async () => {
    const runner = vi.fn().mockResolvedValue({
      code: 0,
      stdout: 'Speech segment 0: start = 0.00, end = 100.00',
      stderr: '',
    });
    const segmenter = new WhisperVadSegmenter({
      binary: 'whisper-vad-speech-segments',
      vadModelPath: '/vad.bin',
      threads: 7,
      runner,
    });
    await segmenter.segments('/a.wav');
    expect(runner.mock.calls[0]![1]).toEqual(expect.arrayContaining(['-t', '7']));
  });

  it('never passes a GPU flag, because the one this binary has aborts', async () => {
    // The binary does have one: `-ug, --use-gpu [false]`, opt-in rather than
    // whisper-cli's opt-out `-ng`/`--no-gpu`. MEASURED that passing it aborts
    // the process (exit 134, SIGABRT, zero segments on stdout), so it is
    // never passed and `resources.gpu` has no effect on segmentation.
    const runner = vi.fn().mockResolvedValue({
      code: 0,
      stdout: 'Speech segment 0: start = 0.00, end = 100.00',
      stderr: '',
    });
    const segmenter = new WhisperVadSegmenter({
      binary: 'whisper-vad-speech-segments',
      vadModelPath: '/vad.bin',
      threads: 7,
      runner,
    });
    await segmenter.segments('/a.wav');
    const args = runner.mock.calls[0]![1] as string[];
    expect(args).not.toContain('-ng');
    expect(args).not.toContain('--no-gpu');
  });
});
