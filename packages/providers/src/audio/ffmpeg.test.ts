import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('FfmpegAudioTool', () => {
  it('probes the duration', async () => {
    const { durationMs } = await new FfmpegAudioTool().probe(source);
    expect(durationMs).toBeGreaterThan(1900);
    expect(durationMs).toBeLessThan(2200);
  });

  it('converts to 16 kHz mono wav', async () => {
    const output = join(dir, 'out.wav');
    await new FfmpegAudioTool().toWav16kMono(source, output);
    const probe = await run('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=sample_rate,channels',
      '-of',
      'json',
      output,
    ]);
    const stream = JSON.parse(probe.stdout).streams[0];
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
