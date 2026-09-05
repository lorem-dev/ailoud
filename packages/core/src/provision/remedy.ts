/**
 * What would fix a failing check, in a form a program can act on.
 *
 * `Check.fix` is a sentence for a human to read; this is the same knowledge
 * shaped for the provisioner to execute. Both live on the check so that
 * `doctor` stays the single source of truth about what is wrong -- the
 * provisioner never re-derives state, it only acts.
 *
 * A check with no remedy is deliberately not auto-fixable. The database
 * check is the one such case: its remedy is "back up, then delete", which
 * is destructive and belongs to a human.
 */
/**
 * The engines `ailoud summarize` can talk to. Declared here rather than only in
 * the CLI's config schema because a provisioning remedy names one, and the two
 * lists drifting apart would let `setup` write a provider the config refuses
 * to parse.
 */
export const LLM_PROVIDERS = ['llama-cpp', 'openai-compatible', 'anthropic', 'claude-cli'] as const;

export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export type Remedy =
  | { readonly kind: 'install-ffmpeg' }
  | { readonly kind: 'install-whisper' }
  | { readonly kind: 'install-diarizer' }
  | { readonly kind: 'install-llm' }
  | { readonly kind: 'download-llm-model' }
  | {
      readonly kind: 'set-llm-provider';
      readonly provider: LlmProvider;
      /** The model id to write alongside it, when one was chosen. */
      readonly model?: string;
    }
  | { readonly kind: 'download-model'; readonly slot: 'transcription' | 'vad' }
  | {
      readonly kind: 'download-diarization-model';
      readonly slot: 'segmentation' | 'embedding';
    }
  | { readonly kind: 'create-directory'; readonly path: string };

export type InstallTarget = 'ffmpeg' | 'whisper' | 'diarizer' | 'llm';

/** What Windows users get told instead of a command ailoud can run for them. */
export const WINDOWS_MANUAL_HINT =
  'install it by hand -- see "Manual install (fallback)" in README.md';

/**
 * The command a user would run by hand for `target` on `platform`.
 *
 * Linux gets `ailoud setup` for whisper rather than an apt command, because
 * there is no apt package for whisper.cpp -- ailoud installs it from the
 * project's own prebuilt release tarball. Printing `apt-get install
 * whisper-cpp` would send people to a package that does not exist.
 *
 * The diarizer never gets a package-manager command on any platform, not
 * just Linux: unlike whisper.cpp, sherpa-onnx has no brew formula either --
 * installSherpa always fetches the project's own release tarball (see
 * sherpaInstall.ts) -- so `ailoud setup` is the only route there is, macOS
 * included.
 *
 * Windows gets neither a package command nor `ailoud setup`: setup refuses to
 * provision Windows (section 3 of the provisioning design), so pointing
 * there would send the user in a circle -- run setup, be told setup cannot
 * help, run doctor, be told to run setup.
 */
export function installHint(target: InstallTarget, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return WINDOWS_MANUAL_HINT;
  }
  if (platform === 'darwin') {
    if (target === 'ffmpeg') return 'brew install ffmpeg';
    if (target === 'whisper') return 'brew install whisper-cpp';
    // llama.cpp has a brew formula too, so say so rather than sending a
    // macOS user through ailoud's own installer for something one command
    // already does.
    if (target === 'llm') return 'brew install llama.cpp';
    return 'ailoud setup';
  }
  if (platform === 'linux' && target === 'ffmpeg') {
    return 'sudo apt-get install ffmpeg';
  }
  return 'ailoud setup';
}
