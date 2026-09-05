import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvironmentError } from '@ailoud/core';
import { NodeFs } from '@ailoud/providers';
import { createContext } from './wiring.js';
import { buildProgram } from './program.js';
import { registryPath } from './projects.js';
import { VERSION } from './version.js';
import { context as fakeCliContext } from './commands/testContext.js';

describe('createContext', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function tempHome(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ailoud-wiring-'));
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

  it('succeeds on a fresh machine, even though stt.whisperCpp.vadModel is unconfigured', async () => {
    const home = await tempHome();
    const context = await createContext({ HOME: home }, () => {});
    try {
      expect(context.config.stt.whisperCpp.vadModel).toBeNull();
    } finally {
      context.store.close();
    }
  });

  it('defers the missing-vad-model failure to createSegmenter() instead of throwing eagerly', async () => {
    const home = await tempHome();
    const context = await createContext({ HOME: home }, () => {});
    try {
      expect(() => context.createSegmenter()).toThrow(EnvironmentError);
      expect(() => context.createSegmenter()).toThrow(/stt\.whisperCpp\.vadModel/);
    } finally {
      context.store.close();
    }
  });

  it('names the config file path in the createSegmenter() failure', async () => {
    const home = await tempHome();
    const context = await createContext({ HOME: home }, () => {});
    try {
      expect(() => context.createSegmenter()).toThrow(
        new RegExp(context.paths.configFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
    } finally {
      context.store.close();
    }
  });

  it('builds a working segmenter once the vad model is configured', async () => {
    const home = await tempHome();
    await mkdir(join(home, '.config', 'ailoud'), { recursive: true });
    await writeFile(
      join(home, '.config', 'ailoud', 'config.yaml'),
      'stt:\n  whisperCpp:\n    model: /models/base.bin\n    vadModel: /models/silero.bin\n',
    );
    const context = await createContext({ HOME: home }, () => {});
    try {
      expect(() => context.createSegmenter()).not.toThrow();
    } finally {
      context.store.close();
    }
  });

  it('defers the missing-segmentation-model failure to createDiarizer() instead of throwing eagerly', async () => {
    const home = await tempHome();
    const context = await createContext({ HOME: home }, () => {});
    try {
      expect(() => context.createDiarizer()).toThrow(EnvironmentError);
      expect(() => context.createDiarizer()).toThrow(/stt\.diarization\.segmentationModel/);
    } finally {
      context.store.close();
    }
  });

  it('names the config file path in the createDiarizer() segmentation-model failure', async () => {
    const home = await tempHome();
    const context = await createContext({ HOME: home }, () => {});
    try {
      expect(() => context.createDiarizer()).toThrow(
        new RegExp(context.paths.configFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
    } finally {
      context.store.close();
    }
  });

  it('reports the missing embedding model once the segmentation model is configured', async () => {
    const home = await tempHome();
    await mkdir(join(home, '.config', 'ailoud'), { recursive: true });
    await writeFile(
      join(home, '.config', 'ailoud', 'config.yaml'),
      'stt:\n  diarization:\n    segmentationModel: /models/segmentation.onnx\n',
    );
    const context = await createContext({ HOME: home }, () => {});
    try {
      expect(() => context.createDiarizer()).toThrow(EnvironmentError);
      expect(() => context.createDiarizer()).toThrow(/stt\.diarization\.embeddingModel/);
    } finally {
      context.store.close();
    }
  });

  it('builds a working diarizer once both diarization models are configured', async () => {
    const home = await tempHome();
    await mkdir(join(home, '.config', 'ailoud'), { recursive: true });
    await writeFile(
      join(home, '.config', 'ailoud', 'config.yaml'),
      'stt:\n  diarization:\n    segmentationModel: /models/segmentation.onnx\n' +
        '    embeddingModel: /models/embedding.onnx\n',
    );
    const context = await createContext({ HOME: home }, () => {});
    try {
      expect(() => context.createDiarizer()).not.toThrow();
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
    await mkdir(join(home, '.config', 'ailoud'), { recursive: true });
    await writeFile(
      join(home, '.config', 'ailoud', 'config.yaml'),
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

describe('project registration (task 10)', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function tempHome(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ailoud-wiring-reg-home-'));
    dirs.push(dir);
    return dir;
  }

  /** A directory with its own `.ailoud/`, so `createContext` treats it as a project library. */
  async function tempProject(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ailoud-wiring-reg-project-'));
    dirs.push(dir);
    await mkdir(join(dir, '.ailoud'), { recursive: true });
    return dir;
  }

  /** A plain directory, with no `.ailoud/` anywhere above it, for the per-user path. */
  async function tempPlainDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ailoud-wiring-reg-plain-'));
    dirs.push(dir);
    return dir;
  }

  async function readRegistry(home: string): Promise<unknown[]> {
    const raw = await readFile(registryPath(join(home, '.local', 'share', 'ailoud')), 'utf8');
    return JSON.parse(raw) as unknown[];
  }

  it('registers a project when a command resolves its library', async () => {
    const home = await tempHome();
    const project = await tempProject();
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(project);
    const context = await createContext({ HOME: home }, () => {});
    try {
      expect(context.paths.isProjectLibrary).toBe(true);
      const entries = (await readRegistry(home)) as Array<{
        path: string;
        libraryDir?: string;
      }>;
      expect(entries).toEqual([
        expect.objectContaining({ path: project, libraryDir: join(project, '.ailoud') }),
      ]);
    } finally {
      context.store.close();
      cwdSpy.mockRestore();
    }
  });

  it('does not register the per-user library', async () => {
    // It always exists, so listing it would be noise.
    const home = await tempHome();
    const plain = await tempPlainDir();
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(plain);
    const context = await createContext({ HOME: home }, () => {});
    try {
      expect(context.paths.isProjectLibrary).toBe(false);
      expect(existsSync(registryPath(join(home, '.local', 'share', 'ailoud')))).toBe(false);
    } finally {
      context.store.close();
      cwdSpy.mockRestore();
    }
  });

  it('registers the project mcp install wrote rules into, with the version', async () => {
    const ctx = fakeCliContext();
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/proj/a');
    try {
      await buildProgram(ctx).parseAsync([
        'node',
        'ailoud',
        'mcp',
        'install',
        '--yes',
        '--target',
        'claude',
        '--location',
        'local',
      ]);
      const raw = await ctx.fs.readTextFile(registryPath(ctx.paths.userDataDir));
      const entries = JSON.parse(raw) as Array<{ path: string; rulesVersion?: string }>;
      const entry = entries.find((candidate) => candidate.path === '/proj/a');
      expect(entry?.rulesVersion).toBe(VERSION);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('registers at most once a day', async () => {
    // The hot-path rule: `createContext` runs before every command, and
    // writing the registry on every single one of them would put a disk
    // write on something as routine as `ailoud ls`.
    const home = await tempHome();
    const project = await tempProject();
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(project);
    const writeSpy = vi.spyOn(NodeFs.prototype, 'writeTextFile');
    try {
      const first = await createContext({ HOME: home }, () => {});
      first.store.close();
      const second = await createContext({ HOME: home }, () => {});
      second.store.close();

      const registryWrites = writeSpy.mock.calls.filter(([path]) => path.includes('projects.json'));
      expect(registryWrites).toHaveLength(1);
    } finally {
      cwdSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });

  it('never fails a command because the registry could not be written', async () => {
    // `ailoud ls` (or any other command) must not die because a bookkeeping
    // file could not be written -- a full disk, a read-only home, or any
    // other permission problem.
    const home = await tempHome();
    const project = await tempProject();
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(project);
    const writeSpy = vi
      .spyOn(NodeFs.prototype, 'writeTextFile')
      .mockRejectedValue(new Error('ENOSPC: no space left on device'));
    try {
      const context = await createContext({ HOME: home }, () => {});
      try {
        expect(context.paths.isProjectLibrary).toBe(true);
      } finally {
        context.store.close();
      }
    } finally {
      cwdSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });
});
