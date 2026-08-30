import type { Diarizer, SpeakerTurn } from '@laud/core';
import { FailureError } from '@laud/core';
import { run as defaultRunner } from '../process/run.js';

// Explicit rather than inherited from the run helper's default, for the same
// reason whisperVad.ts spells its own out: diarization reads the recording
// twice (segmentation, then embeddings) but is far cheaper than
// transcription, so it does not want whisper-cli's six-hour ceiling, and a
// later change to the helper's default must not silently move this.
const DIARIZE_TIMEOUT_MS = 60 * 60_000;

/**
 * One turn line from the diarizer's stdout, e.g.
 * "1.583 -- 3.406 speaker_00". Both times are seconds with three decimals,
 * so both are multiplied by a thousand to reach milliseconds.
 */
const TURN_LINE = /^\s*(\d+(?:\.\d+)?)\s*--\s*(\d+(?:\.\d+)?)\s+(speaker_\d+)\s*$/;

export function parseSpeakerTurns(output: string): SpeakerTurn[] {
  const turns: SpeakerTurn[] = [];
  for (const line of output.split('\n')) {
    const match = TURN_LINE.exec(line);
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) continue;
    turns.push({
      startMs: Math.round(Number(match[1]) * 1000),
      endMs: Math.round(Number(match[2]) * 1000),
      speaker: match[3],
    });
  }
  return turns;
}

export interface SherpaDiarizerOptions {
  readonly binary: string;
  readonly segmentationModel: string;
  readonly embeddingModel: string;
  readonly threshold: number;
  readonly runner?: typeof defaultRunner;
}

export class SherpaDiarizer implements Diarizer {
  private readonly runner: typeof defaultRunner;

  public constructor(private readonly options: SherpaDiarizerOptions) {
    this.runner = options.runner ?? defaultRunner;
  }

  public async turns(
    audioPath: string,
    options: { readonly speakers?: number } = {},
  ): Promise<SpeakerTurn[]> {
    const args = [
      `--segmentation.pyannote-model=${this.options.segmentationModel}`,
      `--embedding.model=${this.options.embeddingModel}`,
      // Given a count, the tool ignores the threshold entirely. Measurements
      // during the design spike showed an explicit count is exact where the
      // threshold only guesses, so pass it whenever the caller supplied one.
      ...(options.speakers === undefined
        ? [`--clustering.cluster-threshold=${this.options.threshold}`]
        : [`--clustering.num-clusters=${options.speakers}`]),
      audioPath,
    ];
    const result = await this.runner(this.options.binary, args, {
      timeoutMs: DIARIZE_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      throw new FailureError(
        `speaker diarization failed: ${result.stderr.trim() || `exit ${result.code}`}`,
      );
    }
    return parseSpeakerTurns(result.stdout);
  }
}
