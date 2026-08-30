import { describe, expect, it } from 'vitest';
import {
  detectPackageManager,
  ffmpegInstallCommands,
  formatInstallCommand,
  whisperInstallCommands,
} from './packageManager.js';

describe('detectPackageManager', () => {
  it('prefers brew on macOS when it is present', async () => {
    const probe = async (name: string) => name === 'brew';
    expect(await detectPackageManager('darwin', probe)).toBe('brew');
  });

  it('finds apt-get on Linux', async () => {
    const probe = async (name: string) => name === 'apt-get';
    expect(await detectPackageManager('linux', probe)).toBe('apt-get');
  });

  it('returns null when nothing usable is installed', async () => {
    expect(await detectPackageManager('linux', async () => false)).toBeNull();
  });

  it('returns null on an unsupported platform even if a probe would succeed', async () => {
    expect(await detectPackageManager('win32', async () => true)).toBeNull();
  });
});

describe('ffmpegInstallCommands', () => {
  it('does not use sudo for brew, and needs no refresh step', () => {
    expect(ffmpegInstallCommands('brew')).toEqual([
      { command: 'brew', args: ['install', 'ffmpeg'], needsSudo: false },
    ]);
  });

  it('refreshes the package lists before installing on apt-get', () => {
    // A container-fresh Debian/Ubuntu has an empty /var/lib/apt/lists, where
    // "apt-get install" exits 100 with nothing the user can act on.
    expect(ffmpegInstallCommands('apt-get').map(formatInstallCommand)).toEqual([
      'sudo apt-get update',
      'sudo apt-get install -y ffmpeg',
    ]);
  });

  it('marks only the refresh optional, so a stale third-party repo cannot block the install', () => {
    const commands = ffmpegInstallCommands('apt-get');
    expect(commands[0]?.optional).toBe(true);
    expect(commands[1]?.optional).toBeUndefined();
  });

  it('uses sudo for both apt-get steps', () => {
    expect(ffmpegInstallCommands('apt-get').every((c) => c.needsSudo)).toBe(true);
  });
});

describe('whisperInstallCommands', () => {
  it('installs whisper-cpp through brew on macOS', () => {
    expect(whisperInstallCommands('brew').map(formatInstallCommand)).toEqual([
      'brew install whisper-cpp',
    ]);
  });

  it('has nothing for apt-get: there is no whisper.cpp package to install', () => {
    expect(whisperInstallCommands('apt-get')).toEqual([]);
  });
});

describe('formatInstallCommand', () => {
  it('renders the exact command line a user would type', () => {
    expect(
      formatInstallCommand({
        command: 'sudo',
        args: ['apt-get', 'install', '-y', 'ffmpeg'],
        needsSudo: true,
      }),
    ).toBe('sudo apt-get install -y ffmpeg');
  });
});
