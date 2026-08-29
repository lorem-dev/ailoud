import { describe, expect, it } from 'vitest';
import { applyConfigUpdates } from './configWrite.js';
import { parseConfig } from './config.js';

describe('applyConfigUpdates', () => {
  it('creates a well-formed config from nothing', () => {
    const out = applyConfigUpdates(null, { model: '/data/models/ggml-small.bin' });
    expect(out).toContain('model: /data/models/ggml-small.bin');
    expect(out).toMatch(/stt:\s*\n\s+whisperCpp:/);
  });

  it('preserves comments and unrelated keys', () => {
    const source = [
      '# my laud config',
      'stt:',
      '  whisperCpp:',
      '    # chosen by hand',
      '    binary: /usr/local/bin/whisper-cli',
      'somethingElse: keep me',
      '',
    ].join('\n');
    const out = applyConfigUpdates(source, { model: '/data/m.bin' });
    expect(out).toContain('# my laud config');
    expect(out).toContain('# chosen by hand');
    expect(out).toContain('binary: /usr/local/bin/whisper-cli');
    expect(out).toContain('somethingElse: keep me');
    expect(out).toContain('model: /data/m.bin');
  });

  it('overwrites a key that is already set', () => {
    const source = 'stt:\n  whisperCpp:\n    model: /old.bin\n';
    const out = applyConfigUpdates(source, { model: '/new.bin' });
    expect(out).toContain('/new.bin');
    expect(out).not.toContain('/old.bin');
  });

  it('writes only the keys it was given', () => {
    const out = applyConfigUpdates(null, { vadModel: '/data/vad.bin' });
    expect(out).toContain('vadModel: /data/vad.bin');
    expect(out).not.toContain('binary:');
  });

  it('is a no-op for no updates', () => {
    const source = '# untouched\nstt: {}\n';
    expect(applyConfigUpdates(source, {})).toBe(source);
  });

  it('round-trips through the real parser', () => {
    // The written file must be readable by the config laud actually uses --
    // otherwise setup leaves the user with a file that fails to load.
    const out = applyConfigUpdates(null, { model: '/m.bin', vadModel: '/v.bin' });
    const parsed = parseConfig(out);
    expect(parsed.stt.whisperCpp.model).toBe('/m.bin');
    expect(parsed.stt.whisperCpp.vadModel).toBe('/v.bin');
  });

  it('produces valid, parseable YAML from an empty source string', () => {
    // parseDocument('') yields a document whose contents start out null;
    // pinning this case guards against a yaml upgrade changing whether
    // setIn can still build the nested path from that empty start.
    const out = applyConfigUpdates('', { binary: '/opt/whisper-cli' });
    const parsed = parseConfig(out);
    expect(parsed.stt.whisperCpp.binary).toBe('/opt/whisper-cli');
  });
});
