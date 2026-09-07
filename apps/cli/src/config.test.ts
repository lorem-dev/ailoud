import { describe, expect, it } from 'vitest';
import { EnvironmentError } from '@ailoud/core';
import { ConfigSchema, parseConfig, resolvePaths } from './config.js';

describe('resolvePaths', () => {
  it('honours both XDG variables', () => {
    expect(resolvePaths({ XDG_CONFIG_HOME: '/c', XDG_DATA_HOME: '/d', HOME: '/h' })).toEqual({
      configFile: '/c/ailoud/config.yaml',
      configHome: '/c',
      dataDir: '/d/ailoud',
      dbFile: '/d/ailoud/ailoud.db',
      mediaRoot: '/d/ailoud/media',
      jobsDir: '/d/ailoud/jobs',
      isProjectLibrary: false,
      userDataDir: '/d/ailoud',
    });
  });

  it('falls back to the documented defaults under HOME', () => {
    expect(resolvePaths({ HOME: '/h' })).toEqual({
      configFile: '/h/.config/ailoud/config.yaml',
      configHome: '/h/.config',
      dataDir: '/h/.local/share/ailoud',
      dbFile: '/h/.local/share/ailoud/ailoud.db',
      mediaRoot: '/h/.local/share/ailoud/media',
      jobsDir: '/h/.local/share/ailoud/jobs',
      isProjectLibrary: false,
      userDataDir: '/h/.local/share/ailoud',
    });
  });

  it('fails clearly when HOME is unset', () => {
    expect(() => resolvePaths({})).toThrow(/HOME/);
    expect(() => resolvePaths({})).toThrow(EnvironmentError);
  });

  it('reports the per-user data directory even inside a project', () => {
    const paths = resolvePaths(
      { HOME: '/home/x', XDG_DATA_HOME: '/home/x/.local/share' },
      { cwd: '/repo/sub', exists: (p) => p === '/repo/.ailoud' },
    );
    // dataDir follows the project; userDataDir must not. The registry, the
    // update-check cache and the log all live per user, and a registry inside
    // a project would list only that project.
    expect(paths.dataDir).toBe('/repo/.ailoud');
    expect(paths.userDataDir).toBe('/home/x/.local/share/ailoud');
  });

  it('resolves configHome by the same empty and relative rules as configFile', () => {
    // An exported-but-empty XDG_CONFIG_HOME means "use the default", and a
    // relative one is invalid and must be ignored -- see absoluteOr above.
    // configHome is read from the same local configFile is built from, so
    // both must move together rather than configHome quietly reading the
    // environment a second time under different rules.
    expect(resolvePaths({ HOME: '/h', XDG_CONFIG_HOME: '' }).configHome).toBe('/h/.config');
    expect(resolvePaths({ HOME: '/h', XDG_CONFIG_HOME: 'relative/path' }).configHome).toBe(
      '/h/.config',
    );
    expect(resolvePaths({ HOME: '/h', XDG_CONFIG_HOME: '/c' }).configHome).toBe('/c');
  });
});

describe('parseConfig', () => {
  it('returns defaults when there is no config file', () => {
    expect(parseConfig(null)).toEqual({
      stt: {
        provider: 'whisper-cpp',
        whisperCpp: {
          binary: 'whisper-cli',
          model: null,
          vadBinary: 'whisper-vad-speech-segments',
          vadModel: null,
        },
        diarization: {
          binary: 'sherpa-onnx-offline-speaker-diarization',
          segmentationModel: null,
          embeddingModel: null,
          threshold: 0.6,
          threads: null,
        },
      },
      llm: {
        // Local by default: the same choice the rest of ailoud makes, and the
        // one that needs no key and sends nothing off the machine.
        provider: 'llama-cpp',
        llamaCpp: {
          binary: 'llama-cli',
          model: null,
          contextTokens: 8192,
          maxOutputTokens: 1024,
          threads: null,
        },
        openaiCompatible: {
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o-mini',
          contextTokens: 128_000,
          maxOutputTokens: 1024,
        },
        anthropic: {
          baseUrl: 'https://api.anthropic.com/v1',
          model: 'claude-sonnet-5',
          contextTokens: 200_000,
          maxOutputTokens: 2048,
        },
        claudeCli: {
          binary: 'claude',
          model: 'sonnet',
          contextTokens: 200_000,
        },
      },
      resources: {
        maxCpuPercent: 90,
        gpu: true,
      },
      audio: {
        denoise: 'auto',
      },
      update: {
        check: true,
      },
    });
  });

  it('defaults the update check to on', () => {
    expect(ConfigSchema.parse({}).update.check).toBe(true);
  });

  it('reads the whisper binary and model', () => {
    const config = parseConfig(
      'stt:\n  provider: whisper-cpp\n  whisperCpp:\n    binary: /opt/whisper\n    model: /m/base.bin\n',
    );
    expect(config.stt.whisperCpp).toEqual({
      binary: '/opt/whisper',
      model: '/m/base.bin',
      vadBinary: 'whisper-vad-speech-segments',
      vadModel: null,
    });
  });

  it('reads the vad binary and model', () => {
    const config = parseConfig(
      'stt:\n  whisperCpp:\n    vadBinary: /opt/whisper-vad\n    vadModel: /m/silero.bin\n',
    );
    expect(config.stt.whisperCpp).toEqual({
      binary: 'whisper-cli',
      model: null,
      vadBinary: '/opt/whisper-vad',
      vadModel: '/m/silero.bin',
    });
  });

  it('defaults whisperCpp fields when only provider is given', () => {
    const config = parseConfig('stt:\n  provider: whisper-cpp\n');
    expect(config.stt.whisperCpp).toEqual({
      binary: 'whisper-cli',
      model: null,
      vadBinary: 'whisper-vad-speech-segments',
      vadModel: null,
    });
  });

  it('still defaults vadModel and vadBinary when only stt.whisperCpp.model is set', () => {
    // Regression guard for the .prefault({}) requirement documented above
    // ConfigSchema: a config that mentions only one leaf of whisperCpp must
    // not lose the other leaves' own defaults.
    const config = parseConfig('stt:\n  whisperCpp:\n    model: /m/base.bin\n');
    expect(config.stt.whisperCpp).toEqual({
      binary: 'whisper-cli',
      model: '/m/base.bin',
      vadBinary: 'whisper-vad-speech-segments',
      vadModel: null,
    });
  });

  it('still defaults binary, embeddingModel, threshold, and threads when only stt.diarization.segmentationModel is set', () => {
    // Regression guard for the .prefault({}) requirement, mirroring the
    // whisperCpp guard above: a config that mentions only one leaf of
    // diarization must not lose the other leaves' own defaults.
    const config = parseConfig('stt:\n  diarization:\n    segmentationModel: /m/seg.onnx\n');
    expect(config.stt.diarization).toEqual({
      binary: 'sherpa-onnx-offline-speaker-diarization',
      segmentationModel: '/m/seg.onnx',
      embeddingModel: null,
      threshold: 0.6,
      threads: null,
    });
  });

  it('reads the diarization binary and threshold', () => {
    const config = parseConfig(
      'stt:\n  diarization:\n    binary: /opt/sherpa\n    threshold: 0.8\n',
    );
    expect(config.stt.diarization).toEqual({
      binary: '/opt/sherpa',
      segmentationModel: null,
      embeddingModel: null,
      threshold: 0.8,
      threads: null,
    });
  });

  it('reads a diarization thread count', () => {
    const config = parseConfig('stt:\n  diarization:\n    threads: 8\n');
    expect(config.stt.diarization.threads).toBe(8);
  });

  it('rejects a thread count that is not a positive integer', () => {
    // A zero, a negative, or a fraction reaches the binary as a flag it
    // would either reject or silently reinterpret; catching it at parse time
    // names the key instead.
    expect(() => parseConfig('stt:\n  diarization:\n    threads: 0\n')).toThrow(
      /stt\.diarization\.threads/,
    );
    expect(() => parseConfig('stt:\n  diarization:\n    threads: 2.5\n')).toThrow(
      /stt\.diarization\.threads/,
    );
  });

  it('names the offending key when the shape is wrong', () => {
    expect(() => parseConfig('stt:\n  provider: 42\n')).toThrow(/stt\.provider/);
  });

  it('rejects an unknown provider by listing the known ones', () => {
    expect(() => parseConfig('stt:\n  provider: magic\n')).toThrow(/whisper-cpp/);
  });

  it('reports a YAML syntax error as a usage error', () => {
    expect(() => parseConfig('stt: [unclosed')).toThrow(/config/i);
  });
});

describe('resource and audio configuration', () => {
  it('defaults to 90 percent, the gpu on, and denoising on auto', () => {
    const config = parseConfig('');
    expect(config.resources).toEqual({ maxCpuPercent: 90, gpu: true });
    expect(config.audio).toEqual({ denoise: 'auto' });
  });

  it('fills in the rest of a partially written resources block', () => {
    // Zod 4's .default() short-circuits on a nested object and would drop
    // `gpu` here; .prefault({}) re-parses and keeps the inner defaults. See
    // the note at the top of config.ts.
    const config = parseConfig('resources:\n  maxCpuPercent: 50\n');
    expect(config.resources).toEqual({ maxCpuPercent: 50, gpu: true });
  });

  it.each([0, 101, -1, 3.5])('refuses a percent of %s', (percent) => {
    expect(() => parseConfig(`resources:\n  maxCpuPercent: ${percent}\n`)).toThrow();
  });

  it('refuses an unknown denoise mode', () => {
    expect(() => parseConfig('audio:\n  denoise: sometimes\n')).toThrow();
  });

  it.each(['auto', 'on', 'off'])('accepts the %s denoise mode', (mode) => {
    expect(parseConfig(`audio:\n  denoise: ${mode}\n`).audio.denoise).toBe(mode);
  });

  it('leaves both thread overrides null by default, meaning follow the budget', () => {
    const config = parseConfig('');
    expect(config.stt.diarization.threads).toBeNull();
    expect(config.llm.llamaCpp.threads).toBeNull();
  });

  it('keeps a thread count someone wrote down', () => {
    // The reason the key stays nullable rather than being deleted: a user who
    // measured their own machine outranks a constant measured on one laptop.
    const config = parseConfig('stt:\n  diarization:\n    threads: 4\n');
    expect(config.stt.diarization.threads).toBe(4);
  });
});
