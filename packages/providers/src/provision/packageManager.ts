import { run } from '../process/run.js';

export type PackageManager = 'brew' | 'apt-get';

export interface InstallCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly needsSudo: boolean;
}

/** Injected in tests; in production it asks the real filesystem via the real PATH. */
export type BinaryProbe = (name: string) => Promise<boolean>;

const realProbe: BinaryProbe = async (name) => {
  try {
    const result = await run(name, ['--version'], { timeoutMs: 10_000 });
    return result.code === 0;
  } catch {
    return false;
  }
};

/**
 * Which package manager laud may drive on this platform, or null.
 *
 * Only the managers this project has verified are listed: brew on macOS,
 * apt-get on Debian and Ubuntu. Adding dnf or pacman is a one-line change
 * plus a verification pass on that distribution -- guessing at their flags
 * from memory is how an installer breaks somebody's machine.
 */
export async function detectPackageManager(
  platform: NodeJS.Platform,
  probe: BinaryProbe = realProbe,
): Promise<PackageManager | null> {
  const candidates: readonly PackageManager[] =
    platform === 'darwin' ? ['brew'] : platform === 'linux' ? ['apt-get'] : [];
  for (const candidate of candidates) {
    if (await probe(candidate)) return candidate;
  }
  return null;
}

/**
 * brew deliberately refuses to run under sudo, and apt-get requires it.
 * `needsSudo` is surfaced so the caller can warn before a password prompt
 * appears, and can skip the action entirely when there is no terminal to
 * type a password into.
 */
export function ffmpegInstallCommand(manager: PackageManager): InstallCommand {
  if (manager === 'brew') {
    return { command: 'brew', args: ['install', 'ffmpeg'], needsSudo: false };
  }
  return { command: 'sudo', args: ['apt-get', 'install', '-y', 'ffmpeg'], needsSudo: true };
}
