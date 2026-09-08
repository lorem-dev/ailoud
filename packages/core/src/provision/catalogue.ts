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
    summary: 'lighter -- what multilingual mode was tuned against',
  },
  {
    /**
     * The default. A 5-bit quantisation of large-v3-turbo, chosen over both
     * `small` (which it replaced) and its own f16 build.
     *
     * MEASURED 2026-09-08 on three corpora -- a 24 kbit/s Russian conference
     * recording, FLEURS ru_ru, LibriSpeech test-clean -- with word error rates
     * compared by a bootstrap over clips:
     *
     *   Russian read speech   `small` 7.5%   this 2.1%
     *   Russian conversation  `small` 32.0%  this 23.6%
     *   Russian at 10 dB SNR  `small` 12.6%  this 3.5%
     *   English read speech   `small` 2.4%   this 1.6%
     *
     * The quantisation is what makes it affordable. Against the f16 build of
     * the same model the difference is statistically indistinguishable on all
     * three corpora, while this file is a third the size. It matters most
     * where there is no GPU: on eight CPU threads this decodes at 0.449 times
     * real time against `small`'s 0.451 and f16 turbo's 0.846, because 5-bit
     * weights halve the memory traffic and memory bandwidth is what limits
     * CPU decoding. So the better model costs nothing at all on a CPU-only
     * machine, and 1.7x `small`'s decode time on a GPU.
     *
     * Do not "upgrade" this entry to the f16 build. That trades 1.1 GB of
     * download and twice the CPU decode time for an accuracy difference no
     * measurement here could separate from zero.
     */
    name: 'large-v3-turbo-q5_0',
    file: 'ggml-large-v3-turbo-q5_0.bin',
    url: `${HF_WHISPER}/ggml-large-v3-turbo-q5_0.bin`,
    bytes: 574_041_195,
    summary: 'the default -- most accurate for its size',
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
 * `file` is the name ailoud gives it on disk, distinct from `archiveMember`
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

/**
 * What `setup` installs when nobody says otherwise. See the entry's own
 * comment above for the measurements that chose it over `small`.
 *
 * An existing installation is never migrated by this constant: a healthy
 * configured model is left alone, and `resolveModelName` prefers whatever is
 * already installed over this default precisely so that changing it here
 * cannot silently replace a model someone chose on purpose.
 */
export const DEFAULT_MODEL_NAME = 'large-v3-turbo-q5_0';

export function findModel(name: string): ModelChoice | undefined {
  return TRANSCRIPTION_MODELS.find((model) => model.name === name);
}

/**
 * The local language model `ailoud setup` installs for summarising.
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
