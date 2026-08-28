import { describe, expect, it } from 'vitest';
import { EnvironmentError } from '@laud/core';
import { parseConfig, resolvePaths } from './config.js';

describe('resolvePaths', () => {
  it('honours both XDG variables', () => {
    expect(resolvePaths({ XDG_CONFIG_HOME: '/c', XDG_DATA_HOME: '/d', HOME: '/h' })).toEqual({
      configFile: '/c/laud/config.yaml',
      dataDir: '/d/laud',
      dbFile: '/d/laud/laud.db',
      mediaRoot: '/d/laud/media',
    });
  });

  it('falls back to the documented defaults under HOME', () => {
    expect(resolvePaths({ HOME: '/h' })).toEqual({
      configFile: '/h/.config/laud/config.yaml',
      dataDir: '/h/.local/share/laud',
      dbFile: '/h/.local/share/laud/laud.db',
      mediaRoot: '/h/.local/share/laud/media',
    });
  });

  it('fails clearly when HOME is unset', () => {
    expect(() => resolvePaths({})).toThrow(/HOME/);
    expect(() => resolvePaths({})).toThrow(EnvironmentError);
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
      },
    });
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
