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

  it('distinguishes "not configured" from "missing" for the vad model check', () => {
    const notConfigured = renderReport([
      {
        name: 'vad model',
        ok: false,
        detail: 'not configured',
        fix: 'set stt.whisperCpp.vadModel in the laud config file to a VAD model path',
      },
    ]);
    expect(notConfigured.lines[0]).toBe('FAIL  vad model             not configured');

    const missing = renderReport([
      {
        name: 'vad model',
        ok: false,
        detail: 'missing: /models/silero.bin',
        fix: 'set stt.whisperCpp.vadModel in the laud config file to a VAD model path',
      },
    ]);
    expect(missing.lines[0]).toBe('FAIL  vad model             missing: /models/silero.bin');
  });

  it('distinguishes "not found on PATH" from "configured path does not exist" for the vad binary check', () => {
    const notOnPath = renderReport([
      {
        name: 'vad binary',
        ok: false,
        detail: 'not found on PATH',
        fix: 'install whisper-cpp',
      },
    ]);
    expect(notOnPath.lines[0]).toBe('FAIL  vad binary            not found on PATH');

    const configuredMissing = renderReport([
      {
        name: 'vad binary',
        ok: false,
        detail: 'configured path does not exist: /opt/vad',
        fix: 'install whisper-cpp',
      },
    ]);
    expect(configuredMissing.lines[0]).toBe(
      'FAIL  vad binary            configured path does not exist: /opt/vad',
    );
  });

  it('renders the full nine-check report ok when every check passes', () => {
    const report = renderReport([
      { name: 'ffmpeg', ok: true, detail: 'v1' },
      { name: 'ffprobe', ok: true, detail: 'v1' },
      { name: 'whisper binary', ok: true, detail: 'whisper-cli' },
      { name: 'whisper model', ok: true, detail: '/m.bin' },
      { name: 'vad model', ok: true, detail: '/v.bin' },
      { name: 'vad binary', ok: true, detail: 'whisper-vad-speech-segments' },
      { name: 'config file', ok: true, detail: '/c' },
      { name: 'database', ok: true, detail: '/d.db' },
      { name: 'media root', ok: true, detail: '/media' },
    ]);
    expect(report.lines).toHaveLength(9);
    expect(report.ok).toBe(true);
  });
});
