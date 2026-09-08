import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { run } from '../process/run.js';
import { FfmpegAudioTool } from './ffmpeg.js';

let dir = '';
let source = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ailoud-audio-'));
  source = join(dir, 'tone.mp3');
  // Two seconds of a 440 Hz tone: small, deterministic, and real media.
  await run('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2',
    source,
  ]);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The first audio stream's sample rate and channel count, as ffprobe sees it. */
async function audioStreamOf(path: string): Promise<{ sample_rate: string; channels: number }> {
  const probe = await run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-show_entries',
    'stream=sample_rate,channels',
    '-of',
    'json',
    path,
  ]);
  return JSON.parse(probe.stdout).streams[0];
}

describe('FfmpegAudioTool', () => {
  it('probes the duration', async () => {
    const { durationMs } = await new FfmpegAudioTool().probe(source);
    expect(durationMs).toBeGreaterThan(1900);
    expect(durationMs).toBeLessThan(2200);
  });

  it('converts to 16 kHz mono wav', async () => {
    const output = join(dir, 'out.wav');
    await new FfmpegAudioTool().toWav16kMono(source, output);
    const stream = await audioStreamOf(output);
    expect(stream.sample_rate).toBe('16000');
    expect(stream.channels).toBe(1);
  });

  it('reports a corrupt file as a failure, not a crash', async () => {
    const bad = join(dir, 'bad.mp3');
    await run('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(bad)}, 'not audio')`]);
    await expect(new FfmpegAudioTool().probe(bad)).rejects.toThrow();
  });

  it('slices a time range into a new file', async () => {
    const output = join(dir, 'slice.wav');
    await new FfmpegAudioTool().slice(source, output, 500, 1500);
    const { durationMs } = await new FfmpegAudioTool().probe(output);
    // A one-second range, allowing for container rounding. Tight enough to
    // catch seconds-versus-milliseconds, which is the mistake worth
    // catching here.
    expect(durationMs).toBeGreaterThan(900);
    expect(durationMs).toBeLessThan(1150);
  });

  it('reports a slice of an unreadable file as a failure', async () => {
    const bad = join(dir, 'bad-slice.mp3');
    await run('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(bad)}, 'x')`]);
    await expect(new FfmpegAudioTool().slice(bad, join(dir, 'o.wav'), 0, 1000)).rejects.toThrow();
  });
});

describe('toWav16kMono denoising', () => {
  // Derived from the constructor itself, rather than redeclared, so the mock
  // types can never drift from what FfmpegAudioTool actually accepts.
  type FfmpegCtorOptions = NonNullable<ConstructorParameters<typeof FfmpegAudioTool>[2]>;
  type Runner = NonNullable<FfmpegCtorOptions['runner']>;
  type Renamer = NonNullable<FfmpegCtorOptions['rename']>;

  function tool(runner: Runner): FfmpegAudioTool {
    // The mocked runner never makes a real ffmpeg write the scratch file, so
    // rename is stubbed too: this suite is about the decision logic (which
    // calls happen, in which order, with what args), not about exercising a
    // real filesystem rename.
    return new FfmpegAudioTool('ffmpeg', 'ffprobe', {
      runner,
      rename: vi.fn<Renamer>().mockResolvedValue(undefined),
    });
  }

  const CLEAN =
    '[Parsed_astats_0 @ 0x1] RMS level dB: -16.17\n[Parsed_astats_0 @ 0x1] Noise floor dB: -43.30';
  const NOISY =
    '[Parsed_astats_0 @ 0x1] RMS level dB: -22.16\n[Parsed_astats_0 @ 0x1] Noise floor dB: -38.94';

  it('does not measure at all when the mode is off', async () => {
    const runner = vi.fn<Runner>().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const prepared = await tool(runner).toWav16kMono('/in.mp4', '/out.wav', { denoise: 'off' });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(prepared).toEqual({ denoised: false, profile: { noiseFloorDb: null, rmsDb: null } });
  });

  it('does not measure at all when no options are given', async () => {
    // Keeps every pre-existing caller and test byte-for-byte unchanged in
    // behaviour: the feature is opt-in from the wiring, not a silent default
    // of the adapter.
    const runner = vi.fn<Runner>().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    await tool(runner).toWav16kMono('/in.mp4', '/out.wav');
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('measures and then leaves clean audio alone in auto mode', async () => {
    const runner = vi
      .fn<Runner>()
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: CLEAN });
    const prepared = await tool(runner).toWav16kMono('/in.mp4', '/out.wav', { denoise: 'auto' });
    expect(runner).toHaveBeenCalledTimes(2);
    expect(prepared.denoised).toBe(false);
    expect(prepared.profile).toEqual({ rmsDb: -16.17, noiseFloorDb: -43.3 });
  });

  it('measures and then filters noisy audio in auto mode', async () => {
    const runner = vi
      .fn<Runner>()
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: NOISY })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
    const prepared = await tool(runner).toWav16kMono('/in.mp4', '/out.wav', { denoise: 'auto' });
    expect(runner).toHaveBeenCalledTimes(3);
    expect(prepared.denoised).toBe(true);
    // The filter writes a scratch file, never the output directly: ffmpeg
    // cannot filter a file in place, and an -i and -y on one path truncates
    // the input before reading it.
    const filterArgs = runner.mock.calls[2]![1] as string[];
    expect(filterArgs).toContain('/out.wav');
    expect(filterArgs[filterArgs.length - 1]).not.toBe('/out.wav');
  });

  it('filters without measuring when the mode is on', async () => {
    const runner = vi.fn<Runner>().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const prepared = await tool(runner).toWav16kMono('/in.mp4', '/out.wav', { denoise: 'on' });
    // Convert, then filter. No measurement: "on" is an instruction.
    expect(runner).toHaveBeenCalledTimes(2);
    expect(prepared.denoised).toBe(true);
  });

  it('keeps the plain conversion when the measurement fails', async () => {
    const runner = vi
      .fn<Runner>()
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockRejectedValueOnce(new Error('ffmpeg exploded'));
    const prepared = await tool(runner).toWav16kMono('/in.mp4', '/out.wav', { denoise: 'auto' });
    expect(prepared).toEqual({ denoised: false, profile: { noiseFloorDb: null, rmsDb: null } });
  });

  it('keeps the plain conversion when the filter pass fails', async () => {
    // The governing principle: denoising is an optimisation, the transcript is
    // the product. A failed filter must leave a usable wav behind, not a
    // half-written one and not an exception.
    const runner = vi
      .fn<Runner>()
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: NOISY })
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'no such filter' });
    const prepared = await tool(runner).toWav16kMono('/in.mp4', '/out.wav', { denoise: 'auto' });
    expect(prepared.denoised).toBe(false);
    expect(prepared.profile.rmsDb).toBe(-22.16);
  });

  it('still throws when the conversion itself fails', async () => {
    // The one failure that IS fatal: without a wav there is nothing to
    // transcribe. This must not be swallowed along with the optional steps.
    const runner = vi.fn<Runner>().mockResolvedValue({ code: 1, stdout: '', stderr: 'bad input' });
    await expect(
      tool(runner).toWav16kMono('/in.mp4', '/out.wav', { denoise: 'auto' }),
    ).rejects.toThrow(/could not convert/);
  });
});

/**
 * The video containers domain/mime.ts knows. `ailoud audio import` accepts
 * video because a meeting recording usually is one, and only the audio track
 * matters -- so each fixture is the same clip of speech wrapped in a different
 * container by scripts/make-fixtures.mjs, and the assertion is that what comes
 * out is the 16 kHz mono WAV whisper.cpp needs, whatever went in.
 */
describe.each(['mp4', 'mov', 'mkv', 'webm'])('a %s recording', (container) => {
  const fixture = fileURLToPath(
    new URL(`../../../../fixtures/en-short.${container}`, import.meta.url),
  );

  it('probes like audio and converts to 16 kHz mono wav', async () => {
    const tool = new FfmpegAudioTool();
    const { durationMs } = await tool.probe(fixture);
    expect(durationMs).toBeGreaterThan(2000);
    expect(durationMs).toBeLessThan(3000);

    const output = join(dir, `${container}.wav`);
    await tool.toWav16kMono(fixture, output);
    const stream = await audioStreamOf(output);
    expect(stream.sample_rate).toBe('16000');
    expect(stream.channels).toBe(1);
  });
});

/**
 * Denoising against a real ffmpeg, not a mocked runner.
 *
 * The mocked suite above proves the decision logic -- which calls happen, in
 * which order. It cannot prove that the arguments those calls carry actually
 * work, and that gap shipped a real defect: `astatsArgs` was missing its
 * trailing `-` output target, so ffmpeg refused to run, every measurement came
 * back as two nulls, and `auto` silently never denoised anything. Every unit
 * test stayed green. These four cases are what would have caught it.
 *
 * The two fixtures are the anchors the threshold was measured against:
 * noisy-short.wav at 16.35 dB SNR must be denoised, en-short.wav at 27.14 dB
 * must not.
 */
describe('denoising real audio', () => {
  const noisy = fileURLToPath(new URL('../../../../fixtures/noisy-short.wav', import.meta.url));
  const clean = fileURLToPath(new URL('../../../../fixtures/en-short.wav', import.meta.url));

  it('measures a real file rather than answering nulls', async () => {
    // The direct regression test for the missing output target. A profile of
    // two nulls here means ffmpeg never produced figures, whatever the reason.
    const output = join(dir, 'measured.wav');
    const prepared = await new FfmpegAudioTool().toWav16kMono(clean, output, { denoise: 'auto' });
    expect(prepared.profile.rmsDb).not.toBeNull();
    expect(prepared.profile.noiseFloorDb).not.toBeNull();
  });

  it('denoises the noisy fixture on auto', async () => {
    const output = join(dir, 'auto-noisy.wav');
    const prepared = await new FfmpegAudioTool().toWav16kMono(noisy, output, { denoise: 'auto' });
    expect(prepared.denoised).toBe(true);
    // Still the shape whisper is fed, after the filter pass and the rename.
    const stream = await audioStreamOf(output);
    expect(stream.sample_rate).toBe('16000');
    expect(stream.channels).toBe(1);
  });

  it('leaves the clean fixture alone on auto', async () => {
    const output = join(dir, 'auto-clean.wav');
    const prepared = await new FfmpegAudioTool().toWav16kMono(clean, output, { denoise: 'auto' });
    expect(prepared.denoised).toBe(false);
  });

  it('leaves no scratch file behind', async () => {
    // applyDenoise writes `<output>.dn.wav` and renames it over the target.
    // A leftover scratch file means the rename did not happen.
    const output = join(dir, 'scratch.wav');
    await new FfmpegAudioTool().toWav16kMono(noisy, output, { denoise: 'on' });
    await expect(stat(`${output}.dn.wav`)).rejects.toThrow();
  });
});
