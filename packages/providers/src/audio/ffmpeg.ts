import type { AudioTool } from '@ailoud/core';
import { FailureError, normalizeRecordedAt } from '@ailoud/core';
import { run } from '../process/run.js';

// Re-encoding audio re-reads the input and writes a new output. The time
// depends on audio length, which is the user's, not ours. A long recording
// legitimately takes minutes to encode. This bound is generous because we
// cannot know how much work ffmpeg has ahead of it.
const ENCODE_TIMEOUT_MS = 30 * 60 * 1000;

export class FfmpegAudioTool implements AudioTool {
  constructor(
    private readonly ffmpeg = 'ffmpeg',
    private readonly ffprobe = 'ffprobe',
  ) {}

  async probe(path: string): Promise<{ durationMs: number; recordedAt: string | null }> {
    // Reading container metadata should be fast. A tight timeout here signals
    // a real problem like a corrupt file or network issue, which is exactly
    // what a timeout is for.
    const result = await run(
      this.ffprobe,
      [
        '-v',
        'error',
        // creation_time comes along for free in the same read. mp4 and mov
        // usually carry it; wav usually does not, which is why the field is
        // nullable rather than required.
        '-show_entries',
        'format=duration:format_tags=creation_time',
        '-of',
        'json',
        path,
      ],
      { timeoutMs: 60_000 },
    );
    if (result.code !== 0) {
      throw new FailureError(`ffprobe could not read ${path}: ${result.stderr.trim()}`);
    }
    const parsed = JSON.parse(result.stdout) as {
      format?: { duration?: string; tags?: { creation_time?: string } };
    };
    const seconds = Number(parsed.format?.duration);
    if (!Number.isFinite(seconds)) {
      throw new FailureError(`ffprobe reported no duration for ${path}`);
    }
    return {
      durationMs: Math.round(seconds * 1000),
      // A missing or nonsense tag is not an import failure: the recording is
      // still perfectly usable, it just has no date of its own.
      recordedAt: normalizeRecordedAt(parsed.format?.tags?.creation_time),
    };
  }

  async toWav16kMono(input: string, output: string): Promise<void> {
    const result = await run(
      this.ffmpeg,
      ['-v', 'error', '-y', '-i', input, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output],
      { timeoutMs: ENCODE_TIMEOUT_MS },
    );
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
    const result = await run(
      this.ffmpeg,
      [
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
      ],
      { timeoutMs: ENCODE_TIMEOUT_MS },
    );
    if (result.code !== 0) {
      throw new FailureError(`ffmpeg could not slice ${input}: ${result.stderr.trim()}`);
    }
  }
}
