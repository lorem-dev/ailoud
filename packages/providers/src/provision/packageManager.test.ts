import { describe, expect, it } from 'vitest';
import { detectPackageManager, ffmpegInstallCommand } from './packageManager.js';

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

describe('ffmpegInstallCommand', () => {
  it('does not use sudo for brew', () => {
    expect(ffmpegInstallCommand('brew')).toEqual({
      command: 'brew',
      args: ['install', 'ffmpeg'],
      needsSudo: false,
    });
  });

  it('uses sudo and -y for apt-get', () => {
    expect(ffmpegInstallCommand('apt-get')).toEqual({
      command: 'sudo',
      args: ['apt-get', 'install', '-y', 'ffmpeg'],
      needsSudo: true,
    });
  });
});
