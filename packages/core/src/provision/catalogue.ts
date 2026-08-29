/** One downloadable model file. `bytes` is for display only -- see plan.ts. */
export interface ModelChoice {
  readonly name: string;
  readonly file: string;
  readonly url: string;
  readonly bytes: number;
  readonly summary: string;
}

const HF_WHISPER = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

/**
 * Sizes were measured against the real endpoints on 2026-08-28. They drive
 * the "this will download N MB" line the user confirms, nothing else: a
 * download is validated against its own response's Content-Length, so an
 * upstream reupload changing a size here cannot break installation.
 */
export const TRANSCRIPTION_MODELS: readonly ModelChoice[] = [
  {
    name: 'tiny',
    file: 'ggml-tiny.bin',
    url: `${HF_WHISPER}/ggml-tiny.bin`,
    bytes: 77_691_713,
    summary: 'fastest, roughest -- good for smoke tests',
  },
  {
    name: 'base',
    file: 'ggml-base.bin',
    url: `${HF_WHISPER}/ggml-base.bin`,
    bytes: 147_951_465,
    summary: 'fast, noticeably better than tiny',
  },
  {
    name: 'small',
    file: 'ggml-small.bin',
    url: `${HF_WHISPER}/ggml-small.bin`,
    bytes: 487_601_967,
    summary: 'the default -- what multilingual mode was tuned against',
  },
  {
    name: 'medium',
    file: 'ggml-medium.bin',
    url: `${HF_WHISPER}/ggml-medium.bin`,
    bytes: 1_533_763_059,
    summary: 'slower, more accurate',
  },
  {
    name: 'large-v3-turbo',
    file: 'ggml-large-v3-turbo.bin',
    url: `${HF_WHISPER}/ggml-large-v3-turbo.bin`,
    bytes: 1_624_555_275,
    summary: 'most accurate, heaviest',
  },
];

/**
 * The VAD model lives in a different Hugging Face repository from the
 * transcription models. The intuitive guess -- alongside them under
 * ggerganov/whisper.cpp -- returns 404.
 */
export const VAD_MODEL: ModelChoice = {
  name: 'silero-v5.1.2',
  file: 'ggml-silero-v5.1.2.bin',
  url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin',
  bytes: 1_055_723,
  summary: 'voice activity detection, needed by --multilingual',
};

export const DEFAULT_MODEL_NAME = 'small';

export function findModel(name: string): ModelChoice | undefined {
  return TRANSCRIPTION_MODELS.find((model) => model.name === name);
}
