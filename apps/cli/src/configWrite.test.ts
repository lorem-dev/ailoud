import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Document } from 'yaml';
import { UsageError } from '@laud/core';
import { applyConfigUpdates, writeConfigUpdates } from './configWrite.js';
import { parseConfig } from './config.js';

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('applyConfigUpdates', () => {
  it('writes the chosen provider two levels down, beside the per-provider blocks', () => {
    // Not three: llm.provider sits directly under llm. The path map used to
    // be a fixed root/section/key triple, which had no shape for this.
    const out = applyConfigUpdates(null, { llmProvider: 'anthropic' });
    expect(parseConfig(out).llm.provider).toBe('anthropic');
    expect(out).toMatch(/llm:\s*\n\s+provider: anthropic/);
  });

  it('leaves an existing llamaCpp block alone when only the provider changes', () => {
    const before = applyConfigUpdates(null, { llmModel: '/models/qwen.gguf' });
    const after = applyConfigUpdates(before, { llmProvider: 'claude-cli' });
    expect(parseConfig(after).llm.llamaCpp.model).toBe('/models/qwen.gguf');
    expect(parseConfig(after).llm.provider).toBe('claude-cli');
  });

  it('names the full path when llm is not a mapping', () => {
    expect(() =>
      applyConfigUpdates('llm: nonsense\n', { llmProvider: 'openai-compatible' }),
    ).toThrow(/"llm\.provider"/);
  });

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

  it('names the problem when the file parses but cannot be serialized back', () => {
    // An unclosed flow sequence somewhere unrelated: setIn succeeds (the
    // broken node and the edited node are different), but toString() refuses
    // to serialize a document carrying parse errors. Before this was
    // rewrapped, the user got a bare "Document with errors cannot be
    // stringified" -- after downloading up to 1.6 GB, with no filename and
    // no hint at what to fix.
    const source = 'stt:\n  whisperCpp:\n    binary: w\nother: [1, 2\n';
    let thrown: unknown;
    try {
      applyConfigUpdates(source, { model: '/m.bin' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UsageError);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toMatch(/not valid YAML/);
    expect(message).toMatch(/end with a \]/);
    expect(message).not.toMatch(/Document with errors cannot be stringified/);
  });

  it('reports the real cause, not "not valid YAML", when toString() fails for another reason', () => {
    // doc.errors stays empty here -- the source parses fine -- so a
    // toString() failure unrelated to a parse error must not be relabelled
    // as one, and must not swallow what actually went wrong.
    const spy = vi.spyOn(Document.prototype, 'toString').mockImplementationOnce(() => {
      throw new Error('boom: not a parse error');
    });
    try {
      let thrown: unknown;
      try {
        applyConfigUpdates('stt:\n  whisperCpp:\n    binary: w\n', { model: '/m.bin' });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(UsageError);
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      expect(message).toContain('boom: not a parse error');
      expect(message).not.toMatch(/not valid YAML/);
    } finally {
      spy.mockRestore();
    }
  });

  it('produces valid, parseable YAML from an empty source string', () => {
    // parseDocument('') yields a document whose contents start out null;
    // pinning this case guards against a yaml upgrade changing whether
    // setIn can still build the nested path from that empty start.
    const out = applyConfigUpdates('', { binary: '/opt/whisper-cli' });
    const parsed = parseConfig(out);
    expect(parsed.stt.whisperCpp.binary).toBe('/opt/whisper-cli');
  });

  it('writes diarization keys under stt.diarization, not stt.whisperCpp', () => {
    // diarizerBinary exists as a distinct ConfigUpdates key precisely so it
    // does not collide with whisperCpp's own `binary` -- both must be able
    // to be set independently, in the same update, without one clobbering
    // the other's section.
    const out = applyConfigUpdates(null, {
      binary: '/opt/whisper-cli',
      diarizerBinary: '/opt/sherpa-onnx-offline-speaker-diarization',
      segmentationModel: '/data/models/sherpa-pyannote-segmentation-3-0.onnx',
      embeddingModel: '/data/models/campplus.onnx',
    });
    expect(out).toMatch(/stt:\s*\n\s+whisperCpp:\s*\n\s+binary: \/opt\/whisper-cli/);
    expect(out).toMatch(/diarization:\s*\n(\s+\S+:.*\n)*\s+binary: \/opt\/sherpa/);
    expect(out).toContain('segmentationModel: /data/models/sherpa-pyannote-segmentation-3-0.onnx');
    expect(out).toContain('embeddingModel: /data/models/campplus.onnx');
  });

  it('round-trips diarization keys through the real parser', () => {
    const out = applyConfigUpdates(null, {
      diarizerBinary: '/opt/sherpa',
      segmentationModel: '/seg.onnx',
      embeddingModel: '/emb.onnx',
    });
    const parsed = parseConfig(out);
    expect(parsed.stt.diarization.binary).toBe('/opt/sherpa');
    expect(parsed.stt.diarization.segmentationModel).toBe('/seg.onnx');
    expect(parsed.stt.diarization.embeddingModel).toBe('/emb.onnx');
  });

  it('names the diarization section when it exists as something other than a mapping', () => {
    const source = 'stt:\n  diarization: not-a-mapping\n';
    let thrown: unknown;
    try {
      applyConfigUpdates(source, { segmentationModel: '/seg.onnx' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UsageError);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain('stt.diarization.segmentationModel');
    expect(message).toContain('stt.diarization');
  });
});

describe('writeConfigUpdates', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'laud-configwrite-'));
    dirs.push(dir);
    return dir;
  }

  it('creates a fresh file when none exists yet (ENOENT)', async () => {
    const dir = await tempDir();
    const target = join(dir, 'config.yaml');
    await writeConfigUpdates(target, { model: '/m.bin' });
    const parsed = parseConfig(await readFile(target, 'utf8'));
    expect(parsed.stt.whisperCpp.model).toBe('/m.bin');
  });

  it('leaves no .tmp file behind after a successful write', async () => {
    const dir = await tempDir();
    const target = join(dir, 'config.yaml');
    await writeConfigUpdates(target, { model: '/m.bin' });
    expect(await readdir(dir)).toEqual(['config.yaml']);
  });

  it('propagates a non-ENOENT read failure and does not write', async () => {
    const dir = await tempDir();
    const target = join(dir, 'config.yaml');
    const original = 'stt:\n  whisperCpp:\n    model: /kept.bin\n';
    await writeFile(target, original, 'utf8');
    await chmod(target, 0o000);
    try {
      // A permission problem must surface as one, not collapse to "no config
      // file yet" and overwrite a file this call was never able to inspect.
      await expect(writeConfigUpdates(target, { model: '/new.bin' })).rejects.toThrow();
    } finally {
      await chmod(target, 0o644); // restore read access so cleanup can inspect/remove it
    }
    expect(await readFile(target, 'utf8')).toBe(original);
    expect(await readdir(dir)).toEqual(['config.yaml']);
  });

  it('leaves a file with unrelated YAML errors untouched', async () => {
    const dir = await tempDir();
    const target = join(dir, 'config.yaml');
    // The broken part (an unclosed flow sequence) is a sibling of stt, not on
    // the path being edited, so setIn succeeds; toString() must still refuse
    // to serialize a document that carries parse errors, so nothing is ever
    // written over this half-edited file.
    const broken = 'stt:\n  whisperCpp:\n    model: /old.bin\nbad: [unclosed\n';
    await writeFile(target, broken, 'utf8');
    await expect(writeConfigUpdates(target, { model: '/new.bin' })).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe(broken);
    expect(await readdir(dir)).toEqual(['config.yaml']);
  });

  it('refuses to clobber "stt" when it already holds a scalar, naming the file and key', async () => {
    const dir = await tempDir();
    const target = join(dir, 'config.yaml');
    const source = 'stt: not-a-mapping\n';
    await writeFile(target, source, 'utf8');
    await expect(writeConfigUpdates(target, { model: '/new.bin' })).rejects.toThrow(
      new RegExp(`${escapeRegExp(target)}.*stt\\.whisperCpp\\.model`, 's'),
    );
    expect(await readFile(target, 'utf8')).toBe(source);
    expect(await readdir(dir)).toEqual(['config.yaml']);
  });

  it('names the config file, and leaves it untouched, when it is not serializable YAML', async () => {
    const dir = await tempDir();
    const target = join(dir, 'config.yaml');
    const source = 'stt:\n  whisperCpp:\n    binary: w\nother: [1, 2\n';
    await writeFile(target, source, 'utf8');
    await expect(writeConfigUpdates(target, { model: '/new.bin' })).rejects.toThrow(
      new RegExp(`${escapeRegExp(target)}.*not valid YAML`, 's'),
    );
    // The original is intact and no half-written temp file is left behind:
    // an installer must never make a file someone is mid-edit on worse.
    expect(await readFile(target, 'utf8')).toBe(source);
    expect(await readdir(dir)).toEqual(['config.yaml']);
  });

  it('refuses to clobber "stt" when it already holds a list', async () => {
    const dir = await tempDir();
    const target = join(dir, 'config.yaml');
    const source = 'stt:\n  - a\n  - b\n';
    await writeFile(target, source, 'utf8');
    await expect(writeConfigUpdates(target, { model: '/new.bin' })).rejects.toThrow(UsageError);
    expect(await readFile(target, 'utf8')).toBe(source);
    expect(await readdir(dir)).toEqual(['config.yaml']);
  });

  it.each([
    ['a colon-space in the path', '/data/models: v2'],
    ['a leading # in the path', '/data/#models'],
    ['a directory literally named "yes"', '/data/yes'],
    ['a directory literally named "1.0"', '/data/1.0'],
  ])('round-trips a path with %s through the real parser', async (_label, value) => {
    const dir = await tempDir();
    const target = join(dir, 'config.yaml');
    await writeConfigUpdates(target, { model: value });
    const parsed = parseConfig(await readFile(target, 'utf8'));
    expect(parsed.stt.whisperCpp.model).toBe(value);
  });
});
