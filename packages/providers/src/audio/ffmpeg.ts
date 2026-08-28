import type { AudioTool } from '@laud/core';
import { FailureError } from '@laud/core';
import { run } from '../process/run.js';

export class FfmpegAudioTool implements AudioTool {
  constructor(
    private readonly ffmpeg = 'ffmpeg',
    private readonly ffprobe = 'ffprobe',
  ) {}

  async probe(path: string): Promise<{ durationMs: number }> {
    const result = await run(
      this.ffprobe,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', path],
      { timeoutMs: 60_000 },
    );
    if (result.code !== 0) {
      throw new FailureError(`ffprobe could not read ${path}: ${result.stderr.trim()}`);
    }
    const parsed = JSON.parse(result.stdout) as { format?: { duration?: string } };
    const seconds = Number(parsed.format?.duration);
    if (!Number.isFinite(seconds)) {
      throw new FailureError(`ffprobe reported no duration for ${path}`);
    }
    return { durationMs: Math.round(seconds * 1000) };
  }

  async toWav16kMono(input: string, output: string): Promise<void> {
    const result = await run(this.ffmpeg, [
      '-v',
      'error',
      '-y',
      '-i',
      input,
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      output,
    ]);
    if (result.code !== 0) {
      throw new FailureError(`ffmpeg could not convert ${input}: ${result.stderr.trim()}`);
    }
  }

  async slice(input: string, output: string, startMs: number, endMs: number): Promise<void> {
    // -ss and -t in seconds with millisecond precision. Re-encoding rather
    // than stream-copying: a copy can only cut on a container keyframe,
    // which would move the boundary by up to several seconds and undo the
    // midpoint the merge step calculated.
    const start = (startMs / 1000).toFixed(3);
    const duration = ((endMs - startMs) / 1000).toFixed(3);
    const result = await run(this.ffmpeg, [
      '-v',
      'error',
      '-y',
      '-ss',
      start,
      '-t',
      duration,
      '-i',
      input,
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      output,
    ]);
    if (result.code !== 0) {
      throw new FailureError(`ffmpeg could not slice ${input}: ${result.stderr.trim()}`);
    }
  }
}
