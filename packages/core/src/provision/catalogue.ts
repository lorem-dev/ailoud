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
 * Every `bytes` in this file is the Content-Length the real endpoint
 * reported: the whisper and VAD entries measured on 2026-08-28, the two
 * diarization entries on 2026-08-31. They drive the "this will download N
 * MB" line the user confirms, nothing else: a download is validated against
 * its own response's Content-Length, so an upstream reupload changing a size
 * here cannot break installation.
 *
 * It is the size of what gets DOWNLOADED, which for an archive entry is the
 * archive and not the member pulled out of it. The segmentation entry was
 * wrong on exactly that distinction until 2026-08-31 -- it carried the size
 * of the extracted `model.onnx`, understating the transfer by 20%.
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
  // The tarball's own Content-Length, not the 5.7 MB `model.onnx` inside it.
  bytes: 6_958_444,
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
  bytes: 28_281_164,
  summary: 'speaker embedding, needed by --diarize',
};

export const DEFAULT_MODEL_NAME = 'small';

export function findModel(name: string): ModelChoice | undefined {
  return TRANSCRIPTION_MODELS.find((model) => model.name === name);
}

/**
 * The local language model `laud setup` installs for summarising.
 *
 * Qwen2.5 3B rather than a Llama of the same size: this tool exists for
 * recordings that are not in English, and a summary of a Russian meeting is
 * only worth having from a model that handles Russian well. Q4_K_M is the
 * quantisation that fits comfortably on an ordinary laptop while staying
 * coherent -- smaller ones start inventing, which is the one thing a summary
 * must not do.
 *
 * From Qwen's own repository rather than a re-upload: one fewer party between
 * the weights and the user. Size measured against the real endpoint.
 */
export const LANGUAGE_MODEL: ModelChoice = {
  name: 'qwen2.5-3b-instruct',
  file: 'qwen2.5-3b-instruct-q4_k_m.gguf',
  url: 'https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf',
  bytes: 2_104_932_768,
  summary: 'local summarisation, multilingual',
};
