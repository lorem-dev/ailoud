import { run } from '../process/run.js';

export type PackageManager = 'brew' | 'apt-get';

export interface InstallCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly needsSudo: boolean;
  /**
   * A non-zero exit from this step is reported but does not abandon the
   * steps after it. `apt-get update` is the case this exists for: refreshing
   * the package lists can fail on one unreachable third-party repository
   * while the install that follows still succeeds from the repositories that
   * did refresh, so treating it as fatal would block an install that works.
   */
  readonly optional?: boolean;
}

/** The exact command line, as it must appear in the consent plan and in logs. */
export function formatInstallCommand(command: InstallCommand): string {
  return [command.command, ...command.args].join(' ');
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
 * The exact commands laud would run to install ffmpeg, in order.
 *
 * A list rather than a single command because apt needs two: on a
 * container-fresh Debian or Ubuntu `/var/lib/apt/lists` is empty, and
 * `apt-get install` there exits 100 with nothing a user could act on. The
 * refresh is part of the install, and being a separate command means it
 * also appears verbatim in the consent plan -- laud never runs a command
 * the user did not read first.
 *
 * brew deliberately refuses to run under sudo, and apt-get requires it.
 * `needsSudo` is surfaced so the caller can warn before a password prompt
 * appears, and can skip the action entirely when there is no terminal to
 * type a password into.
 */
export function ffmpegInstallCommands(manager: PackageManager): readonly InstallCommand[] {
  if (manager === 'brew') {
    return [{ command: 'brew', args: ['install', 'ffmpeg'], needsSudo: false }];
  }
  return [
    { command: 'sudo', args: ['apt-get', 'update'], needsSudo: true, optional: true },
    { command: 'sudo', args: ['apt-get', 'install', '-y', 'ffmpeg'], needsSudo: true },
  ];
}

/**
 * The exact commands laud would run to install whisper.cpp through a package
 * manager, which is only ever brew: there is no apt package for whisper.cpp,
 * so on Linux laud downloads the project's own prebuilt release tarball
 * instead and this list is empty.
 */
export function whisperInstallCommands(manager: PackageManager): readonly InstallCommand[] {
  if (manager === 'brew') {
    return [{ command: 'brew', args: ['install', 'whisper-cpp'], needsSudo: false }];
  }
  return [];
}
