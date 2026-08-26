import { describe, expect, it } from 'vitest';
import { renderReport } from './doctor.js';

describe('renderReport', () => {
  it('marks every passing check and reports ok', () => {
    const report = renderReport([{ name: 'ffmpeg', ok: true, detail: 'version 9.0.1' }]);
    expect(report.ok).toBe(true);
    expect(report.lines).toEqual(['ok    ffmpeg                version 9.0.1']);
  });

  it('prints the fix under a failing check', () => {
    const report = renderReport([
      {
        name: 'whisper model',
        ok: false,
        detail: 'not configured',
        fix: 'set stt.whisperCpp.model in the laud config file to a model path',
      },
    ]);
    expect(report.ok).toBe(false);
    expect(report.lines).toEqual([
      'FAIL  whisper model         not configured',
      '      fix: set stt.whisperCpp.model in the laud config file to a model path',
    ]);
  });

  it('is not ok when any single check fails', () => {
    expect(
      renderReport([
        { name: 'a', ok: true, detail: '' },
        { name: 'b', ok: false, detail: '' },
      ]).ok,
    ).toBe(false);
  });
});
