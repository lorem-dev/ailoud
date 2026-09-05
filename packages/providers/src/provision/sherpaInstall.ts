import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { FailureError } from '@ailoud/core';
import { run } from '../process/run.js';
import { downloadFile } from './download.js';

/**
 * The sherpa-onnx release ailoud installs. Pinned, never "latest": two people
 * running `ailoud setup` a week apart must get the same binary, and an
 * upstream change must not be able to break installation for everyone at
 * once. Bumping this is a reviewable commit.
 */
export const SHERPA_VERSION = 'v1.13.6';

const RELEASES = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';

/**
 * The prebuilt tarball for this platform and CPU.
 *
 * Only macOS arm64 and Linux x64 are covered: those are the two generic
 * shared-library builds this release publishes. Linux arm64 has no
 * equivalent -- the only aarch64 assets in this release are vendor NPU
 * builds (axcl, axera, rknn) that do not run on an ordinary ARM machine, so
 * that target is refused rather than handed a binary that cannot execute.
 */
export function sherpaTarballUrl(platform: NodeJS.Platform, arch: string): string {
  if (platform === 'darwin') {
    if (arch !== 'arm64') {
      // Name the way out, not just the obstacle: this release has no Intel
      // Mac asset at all, so the only route is building from source.
      throw new FailureError(
        `no prebuilt sherpa-onnx diarizer is published for macOS ${arch}; only macOS arm64 is ` +
          'packaged in this release. Build sherpa-onnx from source for this CPU and set ' +
          '"stt.diarization.binary" to the resulting sherpa-onnx-offline-speaker-diarization ' +
          'binary',
      );
    }
    return `${RELEASES}/${SHERPA_VERSION}/sherpa-onnx-${SHERPA_VERSION}-onnxruntime-1.24.4-osx-arm64-shared.tar.bz2`;
  }

  if (platform === 'linux') {
    if (arch !== 'x64') {
      // Name the way out, not just the obstacle: a user on Linux arm64 has
      // no automated route at all (see the vendor-NPU note above) and needs
      // to know building from source is the supported answer, plus which
      // config key to point at the result.
      throw new FailureError(
        `no usable sherpa-onnx diarizer is published for Linux ${arch}; the only aarch64 ` +
          'assets in this release are vendor NPU builds that do not run on a generic ARM ' +
          'machine. Build sherpa-onnx from source for this CPU and set "stt.diarization.binary" ' +
          'to the resulting sherpa-onnx-offline-speaker-diarization binary',
      );
    }
    return `${RELEASES}/${SHERPA_VERSION}/sherpa-onnx-${SHERPA_VERSION}-linux-x64-shared.tar.bz2`;
  }

  throw new FailureError(
    `no prebuilt sherpa-onnx diarizer is published for ${platform}; build sherpa-onnx from ` +
      'source and set "stt.diarization.binary" to the resulting ' +
      'sherpa-onnx-offline-speaker-diarization binary',
  );
}

export interface InstallSherpaOptions {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly dataDir: string;
  readonly onProgress?: (received: number, total: number | null) => void;
}

/**
 * Installs the sherpa-onnx diarizer and returns the absolute path to its
 * binary.
 *
 * The extracted tree is kept intact, exactly like the whisper.cpp tree in
 * whisperInstall.ts: the binary is invoked by absolute path from inside
 * `<dataDir>/sherpa/<SHERPA_VERSION>/`, not copied or symlinked elsewhere,
 * because it ran correctly during the design spike only when left next to
 * whatever else the archive placed alongside it.
 */
export async function installSherpa(options: InstallSherpaOptions): Promise<string> {
  const { platform, arch, dataDir } = options;

  const url = sherpaTarballUrl(platform, arch);
  const root = join(dataDir, 'sherpa', SHERPA_VERSION);
  const archive = join(dataDir, 'sherpa', `sherpa-${SHERPA_VERSION}-${platform}-${arch}.tar.bz2`);
  await mkdir(root, { recursive: true });

  await downloadFile(url, archive, { onProgress: options.onProgress });
  // --strip-components=1 drops the "sherpa-onnx-<version>-.../" wrapper so
  // `bin/`, `lib/`, etc. land directly in `root`. The archive is .tar.bz2,
  // not .tar.gz -- the flag is -xjf, not -xzf.
  const extract = await run('tar', ['-xjf', archive, '-C', root, '--strip-components=1']);
  if (extract.code !== 0) {
    throw new FailureError(`extracting ${archive} failed: ${extract.stderr.trim()}`);
  }
  await rm(archive, { force: true });

  return join(root, 'bin', 'sherpa-onnx-offline-speaker-diarization');
}
