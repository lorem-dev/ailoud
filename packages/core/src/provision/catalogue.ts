/** One downloadable model file. `bytes` is for display only -- see plan.ts. */
export interface ModelChoice {
  readonly name: string;
  readonly file: string;
  readonly url: string;
  readonly bytes: number;
  readonly summary: string;
  /**
   * Present when `url` points at a `.tar.bz2` archive rather than a bare
   * file: the path of the wanted member inside it, once the archive is
   * extracted with `--strip-components=1` (the same convention
   * sherpaInstall.ts and whisperInstall.ts use for their release tarballs).
   * Absent for every entry that downloads straight to `file`.
   *
   * A distinguishing field, not an `endsWith('.tar.bz2')` check on `url`, on
   * purpose: the executor branch that consumes this must not special-case on
   * a string it happens to recognize today.
   */
  readonly archiveMember?: string;
}

const HF_WHISPER = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
const SHERPA_RELEASES = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';

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
  bytes: 885_098,
  summary: 'voice activity detection, needed by --multilingual',
};

/**
 * The pyannote speaker-segmentation model diarization needs. Ships inside a
 * tarball -- every other entry above is a bare file -- alongside an
 * int8-quantized sibling (`model.int8.onnx`) that is deliberately not used
 * here; the design spike settled on the full-precision `model.onnx` (5.7 MB).
 * `file` is the name laud gives it on disk, distinct from `archiveMember`
 * (the name inside the archive) so it does not collide with some other
 * model also called `model.onnx` in a shared `models/` directory.
 *
 * `archiveMember: 'model.onnx'` was verified against the live archive during
 * the design spike: it is a single wrapper directory containing `model.onnx`
 * and `model.int8.onnx` side by side, so extracting with
 * `--strip-components=1` (see provisionRunner.ts) lands `model.onnx`
 * directly -- no nested path to account for.
 */
export const SEGMENTATION_MODEL: ModelChoice = {
  name: 'pyannote-segmentation-3.0',
  file: 'sherpa-pyannote-segmentation-3-0.onnx',
  url: `${SHERPA_RELEASES}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2`,
  bytes: 5_700_000,
  summary: 'speaker segmentation, needed by --diarize',
  archiveMember: 'model.onnx',
};

/**
 * The speaker-embedding model diarization clusters turns against. A bare
 * `.onnx` file, not a tarball. The upstream release path really does say
 * "recongition" (not "recognition") -- that typo is copied verbatim from the
 * real endpoint, not a mistake introduced here.
 */
export const EMBEDDING_MODEL: ModelChoice = {
  name: 'campplus-sv-zh-en',
  file: '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx',
  url: `${SHERPA_RELEASES}/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx`,
  bytes: 27_000_000,
  summary: 'speaker embedding, needed by --diarize',
};

export const DEFAULT_MODEL_NAME = 'small';

export function findModel(name: string): ModelChoice | undefined {
  return TRANSCRIPTION_MODELS.find((model) => model.name === name);
}
