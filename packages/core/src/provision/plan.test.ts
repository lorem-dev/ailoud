import { describe, expect, it } from 'vitest';
import type { Remedy } from './remedy.js';
import { planDownloadBytes, planProvisioning } from './plan.js';
import {
  DEFAULT_MODEL_NAME,
  EMBEDDING_MODEL,
  LANGUAGE_MODEL,
  SEGMENTATION_MODEL,
  VAD_MODEL,
} from './catalogue.js';

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

  it('orders the diarizer binary beside install-whisper, and its models beside download-model', () => {
    const remedies: Remedy[] = [
      { kind: 'download-diarization-model', slot: 'embedding' },
      { kind: 'install-diarizer' },
      { kind: 'download-model', slot: 'transcription' },
      { kind: 'create-directory', path: '/data/media' },
      { kind: 'install-ffmpeg' },
    ];
    expect(planProvisioning(remedies, opts).map((a) => a.kind)).toEqual([
      'create-directory',
      'install-ffmpeg',
      'install-diarizer',
      'download-model',
      'download-diarization-model',
    ]);
  });

  it('resolves each diarization slot to its own catalogue model', () => {
    const [segmentation, embedding] = planProvisioning(
      [
        { kind: 'download-diarization-model', slot: 'segmentation' },
        { kind: 'download-diarization-model', slot: 'embedding' },
      ],
      opts,
    );
    expect(segmentation).toEqual({
      kind: 'download-diarization-model',
      slot: 'segmentation',
      model: SEGMENTATION_MODEL,
    });
    expect(embedding).toEqual({
      kind: 'download-diarization-model',
      slot: 'embedding',
      model: EMBEDDING_MODEL,
    });
  });

  it('does not collapse the segmentation and embedding remedies together, unlike two identical ones', () => {
    // The slot must be part of the dedup key -- otherwise two genuinely
    // different downloads would collapse into a single deduplicated action
    // the way two identical install-ffmpeg remedies are supposed to.
    const remedies: Remedy[] = [
      { kind: 'download-diarization-model', slot: 'segmentation' },
      { kind: 'download-diarization-model', slot: 'embedding' },
      { kind: 'download-diarization-model', slot: 'segmentation' },
    ];
    const actions = planProvisioning(remedies, opts);
    expect(actions).toHaveLength(2);
    expect(actions.map((a) => (a.kind === 'download-diarization-model' ? a.slot : ''))).toEqual([
      'segmentation',
      'embedding',
    ]);
  });

  it('collapses duplicate install-diarizer remedies into one install, like install-ffmpeg', () => {
    const remedies: Remedy[] = [{ kind: 'install-diarizer' }, { kind: 'install-diarizer' }];
    expect(planProvisioning(remedies, opts)).toEqual([{ kind: 'install-diarizer' }]);
  });
});

describe('planDownloadBytes', () => {
  it('counts the language model, the largest download of the lot', () => {
    // Left out, the consent screen understates a two-gigabyte download by two
    // gigabytes -- and consent given on a wrong number is the one thing the
    // plan promises never to ask for.
    const actions = planProvisioning([{ kind: 'download-llm-model' }], opts);
    expect(planDownloadBytes(actions)).toBe(LANGUAGE_MODEL.bytes);
  });

  it('counts diarization model downloads alongside transcription/VAD ones', () => {
    const actions = planProvisioning(
      [
        { kind: 'download-model', slot: 'transcription' },
        { kind: 'download-diarization-model', slot: 'segmentation' },
        { kind: 'download-diarization-model', slot: 'embedding' },
      ],
      opts,
    );
    const model = planProvisioning([{ kind: 'download-model', slot: 'transcription' }], opts)[0];
    const modelBytes =
      model !== undefined && model.kind === 'download-model' ? model.model.bytes : 0;
    expect(planDownloadBytes(actions)).toBe(
      modelBytes + SEGMENTATION_MODEL.bytes + EMBEDDING_MODEL.bytes,
    );
  });

  it('ignores non-download actions', () => {
    expect(planDownloadBytes([{ kind: 'install-diarizer' }, { kind: 'install-ffmpeg' }])).toBe(0);
  });
});
