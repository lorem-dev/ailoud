import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
