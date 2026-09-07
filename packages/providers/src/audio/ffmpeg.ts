import { rm, rename } from 'node:fs/promises';
import type { AudioTool } from '@ailoud/core';
import { FailureError, normalizeRecordedAt, shouldDenoise } from '@ailoud/core';
import type { DenoiseMode, NoiseProfile, WavPrepared } from '@ailoud/core';
import { run } from '../process/run.js';
import { astatsArgs, denoiseArgs, EMPTY_PROFILE, parseNoiseProfile } from './noise.js';

// Re-encoding audio re-reads the input and writes a new output. The time
// depends on audio length, which is the user's, not ours. A long recording
// legitimately takes minutes to encode. This bound is generous because we
// cannot know how much work ffmpeg has ahead of it.
const ENCODE_TIMEOUT_MS = 30 * 60 * 1000;

export class FfmpegAudioTool implements AudioTool {
  private readonly runner: typeof run;
  // Injectable for the same reason as runner: applyDenoise's rename is a real
  // fs call, and a test driving it through a mocked runner never actually
  // makes ffmpeg write the scratch file that rename would need to find.
  private readonly renameFile: typeof rename;

  constructor(
    private readonly ffmpeg = 'ffmpeg',
    private readonly ffprobe = 'ffprobe',
    options: { readonly runner?: typeof run; readonly rename?: typeof rename } = {},
  ) {
    this.runner = options.runner ?? run;
    this.renameFile = options.rename ?? rename;
  }

  async probe(path: string): Promise<{ durationMs: number; recordedAt: string | null }> {
    // Reading container metadata should be fast. A tight timeout here signals
    // a real problem like a corrupt file or network issue, which is exactly
    // what a timeout is for.
    const result = await this.runner(
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

  /**
   * A scan, not an encode: it reads the file and writes nothing, so it gets
   * the probe timeout rather than the encode one. Measured at roughly a
   * thousand times real time.
   */
  private async measure(wavPath: string): Promise<NoiseProfile> {
    try {
      const result = await this.runner(this.ffmpeg, astatsArgs(wavPath), {
        timeoutMs: 60_000,
      });
      // The exit code is not checked: astats prints its figures on stderr and
      // `-f null` makes ffmpeg's own status incidental. A parse that finds
      // nothing already answers "no measurement".
      return parseNoiseProfile(`${result.stdout}\n${result.stderr}`);
    } catch {
      return EMPTY_PROFILE;
    }
  }

  /**
   * Rewrites `wavPath` through the filter chain, via a scratch file.
   *
   * ffmpeg cannot filter a file in place -- `-i x -y x` truncates the input
   * before reading it -- so the filtered audio lands beside the target and is
   * renamed over it. The rename is what makes this atomic from a reader's
   * point of view: either the plain conversion or the cleaned one, never a
   * half-written file.
   *
   * Returns false rather than throwing on any failure, and removes the
   * scratch file. A failed optimisation must leave the plain conversion
   * behind, which is still perfectly transcribable.
   */
  private async applyDenoise(wavPath: string): Promise<boolean> {
    const scratch = `${wavPath}.dn.wav`;
    try {
      const result = await this.runner(this.ffmpeg, denoiseArgs(wavPath, scratch), {
        timeoutMs: ENCODE_TIMEOUT_MS,
      });
      if (result.code !== 0) {
        await rm(scratch, { force: true });
        return false;
      }
      await this.renameFile(scratch, wavPath);
      return true;
    } catch {
      await rm(scratch, { force: true }).catch(() => {});
      return false;
    }
  }

  async toWav16kMono(
    input: string,
    output: string,
    opts: { readonly denoise?: DenoiseMode } = {},
  ): Promise<WavPrepared> {
    const result = await this.runner(
      this.ffmpeg,
      ['-v', 'error', '-y', '-i', input, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output],
      { timeoutMs: ENCODE_TIMEOUT_MS },
    );
    // The one failure here that is genuinely fatal: without a wav there is
    // nothing to transcribe. Everything below it is optional and swallows its
    // own failures.
    if (result.code !== 0) {
      throw new FailureError(`ffmpeg could not convert ${input}: ${result.stderr.trim()}`);
    }

    const mode = opts.denoise ?? 'off';
    if (mode === 'off') return { denoised: false, profile: EMPTY_PROFILE };

    // "on" is an instruction, so it skips the measurement entirely rather
    // than measuring and then ignoring the answer.
    const profile = mode === 'on' ? EMPTY_PROFILE : await this.measure(output);
    if (!shouldDenoise(mode, profile)) return { denoised: false, profile };

    return { denoised: await this.applyDenoise(output), profile };
  }

  async slice(input: string, output: string, startMs: number, endMs: number): Promise<void> {
    // -ss and -t in seconds with millisecond precision. Re-encoding rather
    // than stream-copying: a copy can only cut on a container keyframe,
    // which would move the boundary by up to several seconds and undo the
    // midpoint the merge step calculated.
    const start = (startMs / 1000).toFixed(3);
    const duration = ((endMs - startMs) / 1000).toFixed(3);
    const result = await this.runner(
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
