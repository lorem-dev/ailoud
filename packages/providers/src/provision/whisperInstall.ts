import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { FailureError } from '@laud/core';
import { run, runInteractive } from '../process/run.js';
import { downloadFile } from './download.js';

/**
 * The whisper.cpp release laud installs. Pinned, never "latest": two people
 * running the same `laud setup` a week apart must get the same binaries, and
 * an upstream change must not be able to break installation for everyone at
 * once. Bumping this is a reviewable commit.
 */
export const WHISPER_TAG = 'b4938';

const RELEASES = 'https://github.com/ggml-org/whisper.cpp/releases/download';

/**
 * The prebuilt tarball for this platform and CPU.
 *
 * Linux only. macOS installs through brew, which has a whisper-cpp formula;
 * Linux has no apt package, so laud uses the project's own release assets.
 * Both x64 and arm64 Ubuntu builds are published.
 */
export function whisperTarballUrl(platform: NodeJS.Platform, arch: string): string {
  if (platform !== 'linux') {
    throw new FailureError(`no prebuilt whisper.cpp tarball is published for ${platform}`);
  }
  if (arch !== 'x64' && arch !== 'arm64') {
    throw new FailureError(`no prebuilt whisper.cpp tarball is published for ${arch}`);
  }
  return `${RELEASES}/${WHISPER_TAG}/whisper-bin-ubuntu-${arch}.tar.gz`;
}

export interface InstallWhisperOptions {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly dataDir: string;
  readonly onProgress?: (received: number, total: number | null) => void;
}

export interface WhisperPaths {
  readonly binary: string;
  readonly vadBinary: string;
}

/**
 * Installs whisper.cpp and reports where its binaries ended up.
 *
 * Returns `null` on macOS: brew puts `whisper-cli` on PATH, and laud's
 * existing config defaults already resolve it. Writing an absolute Cellar
 * path into the config there would break on the next `brew upgrade`.
 *
 * On Linux it returns absolute paths, because the extracted tree lives
 * somewhere only laud knows. The tree is kept intact: the binaries embed
 * `$ORIGIN` and load `libwhisper.so` and `libggml*.so` from their own
 * directory, so moving or symlinking a single binary out of it would break
 * the loader.
 */
export async function installWhisper(options: InstallWhisperOptions): Promise<WhisperPaths | null> {
  const { platform, arch, dataDir } = options;

  if (platform === 'darwin') {
    const code = await runInteractive('brew', ['install', 'whisper-cpp']);
    if (code !== 0) throw new FailureError(`"brew install whisper-cpp" exited with code ${code}`);
    return null;
  }

  if (platform !== 'linux') {
    throw new FailureError(
      `laud cannot install whisper.cpp on ${platform} automatically; see README.md for the ` +
        'manual steps',
    );
  }

  const url = whisperTarballUrl(platform, arch);
  const root = join(dataDir, 'whisper', WHISPER_TAG);
  const archive = join(dataDir, 'whisper', `whisper-${WHISPER_TAG}-${arch}.tar.gz`);
  await mkdir(root, { recursive: true });

  await downloadFile(url, archive, { onProgress: options.onProgress });
  // --strip-components=1 drops the "whisper-bin-ubuntu-<arch>/" wrapper so the
  // binaries and their shared libraries land directly in `root`, side by side,
  // which is what $ORIGIN resolution needs.
  const extract = await run('tar', ['-xzf', archive, '-C', root, '--strip-components=1']);
  if (extract.code !== 0) {
    throw new FailureError(`extracting ${archive} failed: ${extract.stderr.trim()}`);
  }
  await rm(archive, { force: true });

  return {
    binary: join(root, 'whisper-cli'),
    vadBinary: join(root, 'whisper-vad-speech-segments'),
  };
}
