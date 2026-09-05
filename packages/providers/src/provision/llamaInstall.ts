import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { FailureError } from '@ailoud/core';
import { run, runInteractive } from '../process/run.js';
import { downloadFile } from './download.js';

/**
 * The llama.cpp build ailoud installs. Pinned, never "latest", for the same
 * reason the whisper.cpp and sherpa-onnx pins exist: two people running the
 * same `ailoud setup` a week apart must get the same binary, and an upstream
 * change must not be able to break installation for everyone at once.
 */
export const LLAMA_VERSION = 'b10712';

const RELEASES = 'https://github.com/ggml-org/llama.cpp/releases/download';

/**
 * The prebuilt archive for this platform and CPU.
 *
 * Every target ailoud supports is published here -- macOS on both
 * architectures, Ubuntu on both -- which is a happier position than the
 * diarizer, where generic Linux arm64 simply does not exist.
 */
export function llamaTarballUrl(platform: NodeJS.Platform, arch: string): string {
  const target =
    platform === 'darwin' && (arch === 'arm64' || arch === 'x64')
      ? `macos-${arch}`
      : platform === 'linux' && (arch === 'arm64' || arch === 'x64')
        ? `ubuntu-${arch}`
        : null;
  if (target === null) {
    throw new FailureError(
      `no prebuilt llama.cpp is published for ${platform} ${arch}; build it from source and set ` +
        '"llm.llamaCpp.binary" to the resulting llama-cli, or set "llm.provider" to a hosted ' +
        'model instead',
    );
  }
  return `${RELEASES}/${LLAMA_VERSION}/llama-${LLAMA_VERSION}-bin-${target}.tar.gz`;
}

export interface InstallLlamaOptions {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly dataDir: string;
  readonly interactive: boolean;
  readonly useBrew: boolean;
  readonly onProgress?: (received: number, total: number | null) => void;
}

export interface InstallLlamaResult {
  /** Absolute path to llama-cli, or null when brew put it on PATH. */
  readonly binary: string | null;
  /** True when the install was skipped because there was no terminal for it. */
  readonly skipped: boolean;
}

/**
 * Installs llama.cpp and reports where its binary ended up.
 *
 * `binary: null` after a brew install, for the same reason the whisper
 * installer returns null there: brew puts llama-cli on PATH where the config
 * default already finds it, and writing an absolute Cellar path into the
 * user's config would break on their next `brew upgrade`.
 */
export async function installLlama(options: InstallLlamaOptions): Promise<InstallLlamaResult> {
  const { platform, arch, dataDir } = options;

  if (options.useBrew) {
    if (!options.interactive) {
      // brew can stop to ask about Xcode tools or directory ownership, and
      // there is no terminal here to answer on. runInteractive has no timeout
      // by design, so this would hang rather than fail.
      return { binary: null, skipped: true };
    }
    const code = await runInteractive('brew', ['install', 'llama.cpp']);
    if (code !== 0) throw new FailureError(`"brew install llama.cpp" exited with code ${code}`);
    return { binary: null, skipped: false };
  }

  const url = llamaTarballUrl(platform, arch);
  const root = join(dataDir, 'llama', LLAMA_VERSION);
  const archive = join(dataDir, 'llama', `llama-${LLAMA_VERSION}-${arch}.tar.gz`);
  await mkdir(root, { recursive: true });

  await downloadFile(url, archive, {
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  });
  // .tar.gz here, unlike sherpa's .tar.bz2: -xzf, not -xjf.
  const extract = await run('tar', ['-xzf', archive, '-C', root, '--strip-components=1']);
  if (extract.code !== 0) {
    throw new FailureError(`extracting ${archive} failed: ${extract.stderr.trim()}`);
  }
  await rm(archive, { force: true });

  // Verified against the real archive rather than assumed: it holds a single
  // top-level directory with llama-cli sitting directly inside it, beside the
  // shared libraries it loads. So --strip-components=1 lands the binary at
  // the root, and the tree must stay intact -- moving the binary out would
  // leave its libraries behind.
  return { binary: join(root, 'llama-cli'), skipped: false };
}
