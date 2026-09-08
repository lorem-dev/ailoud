import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_NAME,
  findModel,
  findModelFile,
  RETIRED_MODELS,
  TRANSCRIPTION_MODELS,
} from './catalogue.js';

/**
 * The retirement contract. Two models were removed from what `setup` offers
 * because measurement showed each is dominated by something smaller, but they
 * are still resolvable -- and the difference between "not offered" and "not
 * resolvable" is exactly what keeps an existing installation working.
 */
describe('the transcription catalogue', () => {
  it('offers the default it names', () => {
    expect(TRANSCRIPTION_MODELS.map((model) => model.name)).toContain(DEFAULT_MODEL_NAME);
  });

  it('does not offer a retired model', () => {
    const offered = TRANSCRIPTION_MODELS.map((model) => model.name);
    for (const retired of RETIRED_MODELS) {
      expect(offered).not.toContain(retired.name);
    }
  });

  it('still resolves a retired model by name, so --model medium keeps working', () => {
    expect(findModel('medium')?.file).toBe('ggml-medium.bin');
    expect(findModel('large-v3-turbo')?.file).toBe('ggml-large-v3-turbo.bin');
  });

  it('still resolves a retired model by file, so an installed one is recognised', () => {
    // The anti-silent-switch guarantee: answering undefined here would make a
    // healthy installed model look unrecognised, and `setup --force` would
    // replace it with the default.
    expect(findModelFile('ggml-medium.bin')?.name).toBe('medium');
  });

  it('resolves offered models too, by either key', () => {
    expect(findModel(DEFAULT_MODEL_NAME)?.name).toBe(DEFAULT_MODEL_NAME);
    expect(findModelFile('ggml-tiny.bin')?.name).toBe('tiny');
  });

  it('answers undefined for a name and a file it has never heard of', () => {
    expect(findModel('enormous-v9')).toBeUndefined();
    expect(findModelFile('ggml-enormous-v9.bin')).toBeUndefined();
  });

  it('has no name or file in both lists', () => {
    // A duplicate would make findModel's answer depend on which list it
    // searched first, which is not a thing a reader should have to know.
    const offeredNames = TRANSCRIPTION_MODELS.map((model) => model.name);
    const offeredFiles = TRANSCRIPTION_MODELS.map((model) => model.file);
    for (const retired of RETIRED_MODELS) {
      expect(offeredNames).not.toContain(retired.name);
      expect(offeredFiles).not.toContain(retired.file);
    }
  });

  it('gives every entry, offered or retired, a url ending in its own file', () => {
    for (const model of [...TRANSCRIPTION_MODELS, ...RETIRED_MODELS]) {
      expect(model.url.endsWith(model.file)).toBe(true);
      expect(model.bytes).toBeGreaterThan(0);
    }
  });
});
