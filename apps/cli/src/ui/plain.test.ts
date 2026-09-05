import { describe, expect, it } from 'vitest';
import type { Recording, Transcript } from '@ailoud/core';
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
  recordedAt: null,
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
    expect(lines).toEqual(['The library is empty. Add something with "ailoud import".']);
  });

  it('writes payload content verbatim, since this is the path a redirect takes', () => {
    const { ui: sink, lines } = ui();
    // PlainUi runs whenever stdout is not a terminal, so `ailoud show ID
    // --format srt > out.srt` comes through here. One added or removed
    // character would corrupt the subtitle file.
    sink.content('1\n00:00:00,000 --> 00:00:01,680\nHello.\n');
    expect(lines).toEqual(['1\n00:00:00,000 --> 00:00:01,680\nHello.\n']);
  });

  it('does not trim a trailing newline out of payload content', () => {
    const { ui: sink, lines } = ui();
    sink.content('{"a":1}\n');
    expect(lines.at(-1)).toBe('{"a":1}\n');
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

  it('keeps the detail column clear of a name longer than the default width', () => {
    // "diarization segmentation model" is 30 characters; against a fixed
    // 22-wide column it ran straight into its own detail:
    // "diarization segmentation modelnot configured".
    const lines: string[] = [];
    const sink = new PlainUi((line) => lines.push(line));
    sink.checks([
      { name: 'ffmpeg', ok: true, detail: 'version 9.0.1' },
      { name: 'diarization segmentation model', ok: true, detail: 'not configured' },
    ]);
    expect(lines[1]).toContain('diarization segmentation model not configured');
    // Still one column: the short name pads out to meet the long one.
    expect(lines[0]!.indexOf('version 9.0.1')).toBe(lines[1]!.indexOf('not configured'));
  });

  it('renders passing and failing checks exactly like the old renderReport output', () => {
    const { ui: sink, lines } = ui();
    sink.checks([
      { name: 'ffmpeg', ok: true, detail: 'version 9.0.1' },
      {
        name: 'whisper model',
        ok: false,
        detail: 'not configured',
        fix: 'set stt.whisperCpp.model in the ailoud config file to a model path',
      },
    ]);
    expect(lines).toEqual([
      'ok    ffmpeg                version 9.0.1',
      'FAIL  whisper model         not configured',
      '      fix: set stt.whisperCpp.model in the ailoud config file to a model path',
    ]);
  });

  it('renders an optional failure as "n/a", not as a second kind of FAIL', () => {
    // blocksReadiness ignores an optional failure, so rendering it in the
    // same red word as a fatal one made the report contradict the exit code:
    // red rows, then a green frame, then exit 0.
    const { ui: sink, lines } = ui();
    sink.checks([
      { name: 'ffmpeg', ok: true, detail: 'version 9.0.1' },
      {
        name: 'diarizer binary',
        ok: false,
        detail: 'not found on PATH',
        fix: 'install sherpa-onnx',
        optional: true,
      },
    ]);
    expect(lines).toEqual([
      'ok    ffmpeg                version 9.0.1',
      'n/a   diarizer binary       not found on PATH',
      '      fix: install sherpa-onnx',
      'note: 1 optional check marked "n/a" above: an opt-in feature is unavailable until that ' +
        'is fixed, but ailoud does not need it to run.',
    ]);
  });

  it('does not print the optional note when nothing optional failed', () => {
    const { ui: sink, lines } = ui();
    sink.checks([
      { name: 'ffmpeg', ok: true, detail: 'version 9.0.1' },
      { name: 'diarizer binary', ok: true, detail: '/opt/sherpa', optional: true },
      { name: 'whisper model', ok: false, detail: 'not configured', fix: 'set it' },
    ]);
    expect(lines.some((line) => line.startsWith('note:'))).toBe(false);
  });

  it('counts every optional failure in the note', () => {
    const { ui: sink, lines } = ui();
    sink.checks([
      { name: 'diarizer binary', ok: false, detail: 'x', optional: true },
      { name: 'diarization segmentation model', ok: false, detail: 'x', optional: true },
    ]);
    expect(lines.at(-1)).toContain('2 optional checks');
  });
});

describe('PlainUi.summarising', () => {
  it('reports countable progress as a percentage', async () => {
    const lines: string[] = [];
    const sink = new PlainUi((line) => lines.push(line));
    await sink.summarising(async (report) => {
      report('Summarising portion', 0, 4);
      report('Summarising portion', 2, 4);
      report('Combining portions', 3, 4);
      return 'x';
    });
    expect(lines).toEqual([
      'Summarising portion 0/4 (0%)',
      'Summarising portion 2/4 (50%)',
      'Combining portions 3/4 (75%)',
    ]);
  });

  it('says nothing when there is one step, rather than writing "1/1 (0%)"', async () => {
    // This path runs when stdout is a pipe: "ailoud summarize ID > out.md" must
    // not get progress chatter in the file.
    const lines: string[] = [];
    const sink = new PlainUi((line) => lines.push(line));
    await sink.summarising(async (report) => {
      report('Summarising', 0, 1);
      return 'x';
    });
    expect(lines).toEqual([]);
  });

  it('returns what the task returned and rethrows what it threw', async () => {
    const sink = new PlainUi(() => {});
    expect(await sink.summarising(async () => 42)).toBe(42);
    await expect(
      sink.summarising(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});
