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
export type Remedy =
  | { readonly kind: 'install-ffmpeg' }
  | { readonly kind: 'install-whisper' }
  | { readonly kind: 'install-diarizer' }
  | { readonly kind: 'download-model'; readonly slot: 'transcription' | 'vad' }
  | {
      readonly kind: 'download-diarization-model';
      readonly slot: 'segmentation' | 'embedding';
    }
  | { readonly kind: 'create-directory'; readonly path: string };

export type InstallTarget = 'ffmpeg' | 'whisper' | 'diarizer';

/** What Windows users get told instead of a command laud can run for them. */
export const WINDOWS_MANUAL_HINT =
  'install it by hand -- see "Manual install (fallback)" in README.md';

/**
 * The command a user would run by hand for `target` on `platform`.
 *
 * Linux gets `laud setup` for whisper rather than an apt command, because
 * there is no apt package for whisper.cpp -- laud installs it from the
 * project's own prebuilt release tarball. Printing `apt-get install
 * whisper-cpp` would send people to a package that does not exist.
 *
 * The diarizer never gets a package-manager command on any platform, not
 * just Linux: unlike whisper.cpp, sherpa-onnx has no brew formula either --
 * installSherpa always fetches the project's own release tarball (see
 * sherpaInstall.ts) -- so `laud setup` is the only route there is, macOS
 * included.
 *
 * Windows gets neither a package command nor `laud setup`: setup refuses to
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
    return 'laud setup';
  }
  if (platform === 'linux' && target === 'ffmpeg') {
    return 'sudo apt-get install ffmpeg';
  }
  return 'laud setup';
}
