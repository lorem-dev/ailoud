import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EnvironmentError } from '@laud/core';
import { createContext } from './wiring.js';

describe('createContext', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function tempHome(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'laud-wiring-'));
    dirs.push(dir);
    return dir;
  }

  it('succeeds on a fresh machine, even though stt.whisperCpp.model is unconfigured', async () => {
    const home = await tempHome();
    const context = await createContext({ HOME: home }, () => {});
    try {
      expect(context.config.stt.whisperCpp.model).toBeNull();
    } finally {
      context.store.close();
    }
  });

  it('defers the missing-model failure to createStt() instead of throwing eagerly', async () => {
    const home = await tempHome();
    const context = await createContext({ HOME: home }, () => {});
    try {
      expect(() => context.createStt()).toThrow(EnvironmentError);
      expect(() => context.createStt()).toThrow(/stt\.whisperCpp\.model/);
    } finally {
      context.store.close();
    }
  });

  it('names the config file path in the createStt() failure', async () => {
    const home = await tempHome();
    const context = await createContext({ HOME: home }, () => {});
    try {
      expect(() => context.createStt()).toThrow(
        new RegExp(context.paths.configFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
    } finally {
      context.store.close();
    }
  });

  it('creates the media root on disk', async () => {
    const home = await tempHome();
    const context = await createContext({ HOME: home }, () => {});
    try {
      const info = await stat(context.paths.mediaRoot);
      expect(info.isDirectory()).toBe(true);
    } finally {
      context.store.close();
    }
  });

  it('builds a working whisper-cpp provider once the model is configured', async () => {
    const home = await tempHome();
    await mkdir(join(home, '.config', 'laud'), { recursive: true });
    await writeFile(
      join(home, '.config', 'laud', 'config.yaml'),
      'stt:\n  whisperCpp:\n    model: /models/base.bin\n',
    );
    const context = await createContext({ HOME: home }, () => {});
    try {
      const stt = context.createStt();
      expect(stt.name).toBe('whisper-cpp');
    } finally {
      context.store.close();
    }
  });
});
