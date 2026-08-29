import { describe, expect, it } from 'vitest';
import type { Remedy } from './remedy.js';
import { planProvisioning } from './plan.js';
import { DEFAULT_MODEL_NAME, VAD_MODEL } from './catalogue.js';

const opts = { modelName: DEFAULT_MODEL_NAME };

describe('planProvisioning', () => {
  it('collapses duplicate ffmpeg remedies into one install', () => {
    // Two separate doctor checks (one for ffmpeg, one for ffprobe) can both
    // emit the same install-ffmpeg remedy, so deduplication is essential.
    const remedies: Remedy[] = [{ kind: 'install-ffmpeg' }, { kind: 'install-ffmpeg' }];
    expect(planProvisioning(remedies, opts)).toEqual([{ kind: 'install-ffmpeg' }]);
  });

  it('orders directories first, then binaries, then models', () => {
    const remedies: Remedy[] = [
      { kind: 'download-model', slot: 'transcription' },
      { kind: 'install-whisper' },
      { kind: 'create-directory', path: '/data/media' },
      { kind: 'install-ffmpeg' },
    ];
    expect(planProvisioning(remedies, opts).map((a) => a.kind)).toEqual([
      'create-directory',
      'install-ffmpeg',
      'install-whisper',
      'download-model',
    ]);
  });

  it('resolves the transcription slot to the chosen model', () => {
    const [action] = planProvisioning([{ kind: 'download-model', slot: 'transcription' }], {
      modelName: 'tiny',
    });
    expect(action).toEqual({
      kind: 'download-model',
      slot: 'transcription',
      model: expect.objectContaining({ name: 'tiny' }),
    });
  });

  it('ignores modelName for the vad slot -- there is only one VAD model', () => {
    const [action] = planProvisioning([{ kind: 'download-model', slot: 'vad' }], {
      modelName: 'tiny',
    });
    expect(action).toEqual({ kind: 'download-model', slot: 'vad', model: VAD_MODEL });
  });

  it('rejects an unknown model name rather than silently substituting one', () => {
    expect(() =>
      planProvisioning([{ kind: 'download-model', slot: 'transcription' }], {
        modelName: 'enormous',
      }),
    ).toThrow(/enormous/);
  });

  it('keeps distinct directories apart while deduplicating repeats', () => {
    const remedies: Remedy[] = [
      { kind: 'create-directory', path: '/a' },
      { kind: 'create-directory', path: '/a' },
      { kind: 'create-directory', path: '/b' },
    ];
    const actions = planProvisioning(remedies, opts);
    expect(actions).toHaveLength(2);
    expect(actions.map((a) => (a.kind === 'create-directory' ? a.path : ''))).toEqual(['/a', '/b']);
  });

  it('returns an empty plan for no remedies', () => {
    expect(planProvisioning([], opts)).toEqual([]);
  });
});
