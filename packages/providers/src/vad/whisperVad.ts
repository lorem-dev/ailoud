import type { SpeechSegmenter, SpeechSpan } from '@laud/core';
import { FailureError } from '@laud/core';
import { run as defaultRunner } from '../process/run.js';

/**
 * Matches one segment line from whisper-vad-speech-segments' stdout.
 *
 * NOT the shape the task brief assumed ("0.00 - 175.00"): a real run against
 * fixtures/mixed-short.wav with -np produced lines shaped like
 * "Speech segment 0: start = 0.00, end = 346.00", preceded by a
 * "Detected N speech segments:" header. Both captures are centiseconds per
 * the tool's own help text, so both are multiplied by ten to reach
 * milliseconds.
 */
const SEGMENT_LINE =
  /^\s*Speech segment \d+:\s*start\s*=\s*(\d+(?:\.\d+)?)\s*,\s*end\s*=\s*(\d+(?:\.\d+)?)\s*$/;

export function parseVadSegments(output: string): SpeechSpan[] {
  const spans: SpeechSpan[] = [];
  for (const line of output.split('\n')) {
    const match = SEGMENT_LINE.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    spans.push({
      startMs: Math.round(Number(match[1]) * 10),
      endMs: Math.round(Number(match[2]) * 10),
    });
  }
  return spans;
}

export interface WhisperVadOptions {
  readonly binary: string;
  readonly vadModelPath: string;
  readonly runner?: typeof defaultRunner;
}

export class WhisperVadSegmenter implements SpeechSegmenter {
  private readonly runner: typeof defaultRunner;

  public constructor(private readonly options: WhisperVadOptions) {
    this.runner = options.runner ?? defaultRunner;
  }

  public async segments(audioPath: string): Promise<SpeechSpan[]> {
    const result = await this.runner(
      this.options.binary,
      ['-f', audioPath, '-vm', this.options.vadModelPath, '-np'],
      { timeoutMs: 30 * 60_000 },
    );
    if (result.code !== 0) {
      throw new FailureError(
        `speech segmentation failed: ${result.stderr.trim() || `exit ${result.code}`}`,
      );
    }
    const spans = parseVadSegments(result.stdout);
    if (spans.length === 0) {
      throw new FailureError(
        `no speech found in ${audioPath}; transcribe it without --multilingual`,
      );
    }
    return spans;
  }
}
