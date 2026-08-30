import { describe, expect, it } from 'vitest';
import type { Recording, Transcript } from '@laud/core';
import { PlainUi } from './plain.js';

const RECORDING: Recording = {
  id: 'ID001',
  sha256: 'sha-x',
  sourcePath: '/in/a.mp3',
  mediaPath: 'sh/a.mp3',
  durationMs: 3200,
  mime: 'audio/mpeg',
  title: null,
  notes: null,
  importedAt: '2026-01-01T00:00:00.000Z',
};

const TRANSCRIPT: Transcript = {
  id: 'T1',
  recordingId: 'ID001',
  provider: 'fake',
  model: 'base.bin',
  language: 'ru',
  text: 'Privet.',
  createdAt: '2026-01-01T00:00:01.000Z',
};

function ui(): { ui: PlainUi; lines: string[] } {
  const lines: string[] = [];
  return { ui: new PlainUi((line) => lines.push(line)), lines };
}

describe('PlainUi', () => {
  it('frame prints nothing and returns the task result', async () => {
    const { ui: sink, lines } = ui();
    const result = await sink.frame('import', async () => 'ok');
    expect(result).toBe('ok');
    expect(lines).toEqual([]);
  });

  it('frame prints nothing and still rethrows on failure', async () => {
    const { ui: sink, lines } = ui();
    await expect(
      sink.frame('import', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(lines).toEqual([]);
  });

  it('reports an import exactly like the old context.out line', () => {
    const { ui: sink, lines } = ui();
    sink.imported(RECORDING, false);
    expect(lines).toEqual(['ID001  imported  /in/a.mp3']);
  });

  it('reports an already-present import exactly like the old context.out line', () => {
    const { ui: sink, lines } = ui();
    sink.imported(RECORDING, true);
    expect(lines).toEqual(['ID001  already present  /in/a.mp3']);
  });

  it('runs transcribing silently and returns the task result', async () => {
    const { ui: sink, lines } = ui();
    const result = await sink.transcribing(RECORDING, async () => 'ok');
    expect(result).toBe('ok');
    expect(lines).toEqual([]);
  });

  it('propagates a transcribing failure without printing anything', async () => {
    const { ui: sink, lines } = ui();
    await expect(
      sink.transcribing(RECORDING, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(lines).toEqual([]);
  });

  it('reports a transcribed recording exactly like the old context.out line', () => {
    const { ui: sink, lines } = ui();
    sink.transcribed(RECORDING, TRANSCRIPT, 1, []);
    expect(lines).toEqual(['ID001  ru  1 segment']);
  });

  it('pluralizes segment count', () => {
    const { ui: sink, lines } = ui();
    sink.transcribed(RECORDING, TRANSCRIPT, 3, []);
    expect(lines).toEqual(['ID001  ru  3 segments']);
  });

  it('names every language of a code-switched recording, not just the dominant one', () => {
    const { ui: sink, lines } = ui();
    // TRANSCRIPT.language is 'ru' -- the stored dominant code. The recording
    // is half English, and saying only "ru" would misreport it.
    sink.transcribed(RECORDING, TRANSCRIPT, 2, ['en', 'ru']);
    expect(lines).toEqual(['ID001  en+ru  2 segments']);
  });

  it('falls back to the stored language when no per-segment language was recorded', () => {
    const { ui: sink, lines } = ui();
    sink.transcribed(RECORDING, TRANSCRIPT, 1, []);
    expect(lines).toEqual(['ID001  ru  1 segment']);
  });

  it('reports a skip exactly like the old context.out line', () => {
    const { ui: sink, lines } = ui();
    sink.skipped(RECORDING);
    expect(lines).toEqual(['ID001  already transcribed (use --force)']);
  });

  it('reports nothing to transcribe exactly like the old context.out line', () => {
    const { ui: sink, lines } = ui();
    sink.nothingToTranscribe();
    expect(lines).toEqual(['Nothing to transcribe.']);
  });

  it('reports an empty library exactly like the old context.out line', () => {
    const { ui: sink, lines } = ui();
    sink.emptyLibrary();
    expect(lines).toEqual(['The library is empty. Add something with "laud import".']);
  });

  it('renders one ls row per recording exactly like the old context.out line', () => {
    const { ui: sink, lines } = ui();
    sink.recordings([{ id: 'ID001', durationMs: 3200, language: 'ru', preview: 'Privet.' }]);
    expect(lines).toEqual(['ID001  00:00:03  ru  "Privet."']);
  });

  it('trims trailing blank columns for a row with no language or preview yet', () => {
    const { ui: sink, lines } = ui();
    sink.recordings([{ id: 'ID001', durationMs: 3200, language: null, preview: '' }]);
    expect(lines).toEqual(['ID001  00:00:03']);
  });

  it('renders passing and failing checks exactly like the old renderReport output', () => {
    const { ui: sink, lines } = ui();
    sink.checks([
      { name: 'ffmpeg', ok: true, detail: 'version 9.0.1' },
      {
        name: 'whisper model',
        ok: false,
        detail: 'not configured',
        fix: 'set stt.whisperCpp.model in the laud config file to a model path',
      },
    ]);
    expect(lines).toEqual([
      'ok    ffmpeg                version 9.0.1',
      'FAIL  whisper model         not configured',
      '      fix: set stt.whisperCpp.model in the laud config file to a model path',
    ]);
  });
});
