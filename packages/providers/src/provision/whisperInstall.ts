import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { FailureError } from '@ailoud/core';
import { run, runInteractive } from '../process/run.js';
import { formatInstallCommand, whisperInstallCommands } from './packageManager.js';
import { downloadFile } from './download.js';

/**
 * The whisper.cpp release ailoud installs. Pinned, never "latest": two people
 * running the same `ailoud setup` a week apart must get the same binaries, and
 * an upstream change must not be able to break installation for everyone at
 * once. Bumping this is a reviewable commit.
 */
export const WHISPER_TAG = 'b4938';

const RELEASES = 'https://github.com/ggml-org/whisper.cpp/releases/download';

/**
 * The prebuilt tarball for this platform and CPU.
 *
 * Linux only. macOS installs through brew, which has a whisper-cpp formula;
 * Linux has no apt package, so ailoud uses the project's own release assets.
 * Both x64 and arm64 Ubuntu builds are published.
 */
export function whisperTarballUrl(platform: NodeJS.Platform, arch: string): string {
  if (platform !== 'linux') {
    throw new FailureError(`no prebuilt whisper.cpp tarball is published for ${platform}`);
  }
  if (arch !== 'x64' && arch !== 'arm64') {
    // Name the way out, not just the obstacle: only x64 and arm64 Linux
    // builds are published, so a user on anything else has no automated
    // route at all and needs to know that building it themselves is the
    // supported answer rather than a workaround.
    throw new FailureError(
      `no prebuilt whisper.cpp tarball is published for ${arch}; build whisper.cpp from ` +
        'source and set "stt.whisperCpp.binary" and "stt.whisperCpp.vadBinary" to the ' +
        'resulting binaries',
    );
  }
  return `${RELEASES}/${WHISPER_TAG}/whisper-bin-ubuntu-${arch}.tar.gz`;
}

export interface InstallWhisperOptions {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly dataDir: string;
  /**
   * Whether a real terminal is attached. The macOS route shells out to brew
   * through `runInteractive`, which has no timeout by design (a password or
   * a "install the Xcode command line tools?" prompt must be allowed to
   * wait), so with nothing on stdin it would wait forever. False means
   * report the command instead of running it -- refusing beats hanging a CI
   * job until it times out.
   */
  readonly interactive: boolean;
  readonly onProgress?: (received: number, total: number | null) => void;
}

export interface WhisperPaths {
  readonly binary: string;
  readonly vadBinary: string;
}

/**
 * `paths` is null when whisper.cpp landed on PATH and ailoud therefore records
 * nothing (the macOS/brew route). `skipped` carries the exact commands a
 * human has to run, for the non-interactive case where ailoud refuses to spawn
 * something that could block on a prompt.
 */
export type InstallWhisperResult =
  | { readonly kind: 'installed'; readonly paths: WhisperPaths | null }
  | { readonly kind: 'skipped'; readonly commands: readonly string[] };

/**
 * Installs whisper.cpp and reports where its binaries ended up.
 *
 * Reports `paths: null` on macOS: brew puts `whisper-cli` on PATH, and ailoud's
 * existing config defaults already resolve it. Writing an absolute Cellar
 * path into the config there would break on the next `brew upgrade`.
 *
 * On Linux it returns absolute paths, because the extracted tree lives
 * somewhere only ailoud knows. The tree is kept intact: the binaries embed
 * `$ORIGIN` and load `libwhisper.so` and `libggml*.so` from their own
 * directory, so moving or symlinking a single binary out of it would break
 * the loader.
 */
export async function installWhisper(
  options: InstallWhisperOptions,
): Promise<InstallWhisperResult> {
  const { platform, arch, dataDir } = options;

  if (platform === 'darwin') {
    const commands = whisperInstallCommands('brew');
    if (!options.interactive) {
      return { kind: 'skipped', commands: commands.map(formatInstallCommand) };
    }
    for (const command of commands) {
      const code = await runInteractive(command.command, command.args);
      if (code !== 0) {
        throw new FailureError(`"${formatInstallCommand(command)}" exited with code ${code}`);
      }
    }
    return { kind: 'installed', paths: null };
  }

  if (platform !== 'linux') {
    throw new FailureError(
      `ailoud cannot install whisper.cpp on ${platform} automatically; see README.md for the ` +
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
    kind: 'installed',
    paths: {
      binary: join(root, 'whisper-cli'),
      vadBinary: join(root, 'whisper-vad-speech-segments'),
    },
  };
}
