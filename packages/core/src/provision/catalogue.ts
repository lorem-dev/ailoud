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
    /**
     * The deliberate maximum. Measurably better than the default only on hard
     * audio -- about 2 points on the supplied conference recording -- and
     * indistinguishable from it on clean Russian, on spontaneous Russian and
     * on far-field meeting audio, where it was in fact 2 points WORSE. It also
     * decodes at 0.203 against the default's 0.112, so it is the right answer
     * for a difficult recording somebody cares about and the wrong one for a
     * library.
     */
    name: 'large-v3',
    file: 'ggml-large-v3.bin',
    url: `${HF_WHISPER}/ggml-large-v3.bin`,
    bytes: 3_095_033_483,
    summary: 'heaviest -- a little better on hard audio',
  },
];

/**
 * Models an earlier version offered and this one does not.
 *
 * MEASURED 2026-09-08 (see the default's comment above for the corpora): each
 * is dominated by something smaller. `medium` is larger, slower AND less
 * accurate than large-v3-turbo on every corpus tried; `large-v3-turbo` in f16
 * is 2.8x the default's download and, without a GPU, 1.9x its decode time,
 * for an accuracy difference no comparison could separate from zero.
 *
 * Still resolvable rather than deleted, for two reasons that both bite
 * existing installations:
 *
 *   - `ailoud setup --model medium` keeps working. Somebody's script says
 *     that, and the model itself is fine -- it is merely a poor choice.
 *   - `findModelFile` still recognises an installed one AS itself. Without
 *     that, `setup --force` on a machine running `medium` would see a
 *     stranger's file where its own catalogue name should be, fall through to
 *     DEFAULT_MODEL_NAME, and silently replace a healthy model the user chose
 *     on purpose. That exact silent switch was found and fixed once already.
 *
 * They are absent from TRANSCRIPTION_MODELS, so the interactive picker and
 * the "choose one of" message offer only the list above. Nothing here should
 * be recommended to anyone.
 */
export const RETIRED_MODELS: readonly ModelChoice[] = [
  {
    name: 'medium',
    file: 'ggml-medium.bin',
    url: `${HF_WHISPER}/ggml-medium.bin`,
    bytes: 1_533_763_059,
    summary: 'retired -- large-v3-turbo-q5_0 is smaller, faster and better',
  },
  {
    name: 'large-v3-turbo',
    file: 'ggml-large-v3-turbo.bin',
    url: `${HF_WHISPER}/ggml-large-v3-turbo.bin`,
    bytes: 1_624_555_275,
    summary: 'retired -- the q5_0 build of it is a third the size, and no worse',
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

/**
 * A model by catalogue name, retired ones included.
 *
 * Resolving covers more than offering: a name this returns is one `--model`
 * accepts and `setup` can install. The offered list is TRANSCRIPTION_MODELS,
 * and only that list belongs in a picker or a "choose one of" message.
 */
export function findModel(name: string): ModelChoice | undefined {
  return (
    TRANSCRIPTION_MODELS.find((model) => model.name === name) ??
    RETIRED_MODELS.find((model) => model.name === name)
  );
}

/**
 * A model by the file name it is stored under, retired ones included.
 *
 * This is how an installed model is recognised as itself. Answering
 * `undefined` for a model that is merely no longer offered would make
 * `setup --force` treat a healthy install as unrecognised and replace it.
 */
export function findModelFile(file: string): ModelChoice | undefined {
  return (
    TRANSCRIPTION_MODELS.find((model) => model.file === file) ??
    RETIRED_MODELS.find((model) => model.file === file)
  );
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
