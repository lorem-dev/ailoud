import { describe, expect, it, vi } from 'vitest';
import stringWidth from 'string-width';

// `vi.hoisted` so these mocks exist before vitest hoists the `vi.mock` call
// itself above this file's imports -- referencing plain top-level consts in
// the factory below would otherwise risk "cannot access before
// initialization". Real @clack/prompts writes ANSI escapes to a real
// terminal; none of that belongs in a unit test, so every export PrettyUi
// touches is replaced with a spy.
const { intro, outro, log, spinner, spinnerHandle } = vi.hoisted(() => {
  const handle = {
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    clear: vi.fn(),
    isCancelled: false,
  };
  return {
    intro: vi.fn(),
    outro: vi.fn(),
    log: {
      message: vi.fn(),
      info: vi.fn(),
      success: vi.fn(),
      step: vi.fn(),
      warn: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    },
    spinner: vi.fn(() => handle),
    spinnerHandle: handle,
  };
});

vi.mock('@clack/prompts', () => ({ intro, outro, log, spinner }));

import type { Recording } from '@laud/core';
import { PrettyUi } from './pretty.js';

const A_RECORDING: Recording = {
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

describe('PrettyUi.frame', () => {
  it('opens a frame and closes it with a success status', async () => {
    intro.mockClear();
    outro.mockClear();
    const ui = new PrettyUi();
    const result = await ui.frame('import', async () => 'ok');
    expect(result).toBe('ok');
    expect(intro).toHaveBeenCalledTimes(1);
    expect(intro.mock.calls[0]?.[0]).toBe('import');
    expect(outro).toHaveBeenCalledTimes(1);
    expect(outro.mock.calls[0]?.[0]).toContain('Done');
  });

  it('still closes the frame, with a failure status, when the task throws', async () => {
    intro.mockClear();
    outro.mockClear();
    const ui = new PrettyUi();
    const error = new Error('boom');
    await expect(
      ui.frame('transcribe', async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(intro).toHaveBeenCalledTimes(1);
    expect(outro).toHaveBeenCalledTimes(1);
    const outroMessage = outro.mock.calls[0]?.[0] as string;
    expect(outroMessage).toContain('Failed');
    // The outro states the outcome only. The top-level handler prints the
    // error itself, and carrying it here too made doctor report the same
    // failure twice, reading as two separate problems.
    expect(outroMessage).not.toContain('boom');
  });

  it('rethrows a non-Error thrown value unchanged, and still closes the frame', async () => {
    intro.mockClear();
    outro.mockClear();
    const ui = new PrettyUi();
    await expect(
      ui.frame('ls', async () => {
        throw 'not an Error';
      }),
    ).rejects.toBe('not an Error');
    expect(outro).toHaveBeenCalledTimes(1);
    // The outcome alone -- neither the label nor the error text, both of
    // which are already on screen from the intro and the top-level handler.
    expect(outro.mock.calls[0]?.[0]).toContain('Failed');
    expect(outro.mock.calls[0]?.[0]).not.toContain('ls');
  });

  it('reports the runtime of a command that took a while', async () => {
    intro.mockClear();
    outro.mockClear();
    // An injected clock, so the assertion is an exact string rather than a
    // moving number. First call opens the frame, second closes it.
    const times = [0, 1300];
    const ui = new PrettyUi(Number.POSITIVE_INFINITY, () => times.shift() ?? 0);
    await ui.frame('transcribe', async () => undefined);
    expect(outro.mock.calls[0]?.[0]).toContain('Done in 1.300s');
  });

  it('stays silent about the runtime of a command that finished instantly', async () => {
    intro.mockClear();
    outro.mockClear();
    // `laud ls` finishing in four milliseconds does not need a stopwatch
    // reading; a duration on every command would drown the one that matters.
    const times = [0, 4];
    const ui = new PrettyUi(Number.POSITIVE_INFINITY, () => times.shift() ?? 0);
    await ui.frame('ls', async () => undefined);
    expect(outro.mock.calls[0]?.[0]).toContain('Done');
    expect(outro.mock.calls[0]?.[0]).not.toContain('in ');
  });

  it('reports the runtime of a long command that failed', async () => {
    intro.mockClear();
    outro.mockClear();
    // Knowing a transcription ran for two minutes before dying is as useful
    // as knowing it ran for two minutes and worked.
    const times = [0, 125_000];
    const ui = new PrettyUi(Number.POSITIVE_INFINITY, () => times.shift() ?? 0);
    await expect(
      ui.frame('transcribe', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(outro.mock.calls[0]?.[0]).toContain('Failed in 2m 5.000s');
  });

  it('renders payload content inside the frame, not spilling out around it', async () => {
    log.message.mockClear();
    const ui = new PrettyUi(72);
    ui.content('[00:00:00] Hello.\n[00:00:01] Privet.\n');
    // log.message is what draws inside the frame's gutter; the payload must
    // go through it rather than straight to stdout.
    expect(log.message).toHaveBeenCalledTimes(1);
    expect(log.message.mock.calls[0]?.[0]).toBe('[00:00:00] Hello.\n[00:00:01] Privet.');
  });

  it('wraps a payload line too long for the terminal, so it cannot tear the frame', () => {
    log.message.mockClear();
    const ui = new PrettyUi(40);
    ui.content('x'.repeat(100));
    const rendered = log.message.mock.calls[0]?.[0] as string;
    expect(rendered.split('\n').length).toBeGreaterThan(1);
    for (const line of rendered.split('\n')) {
      expect(stringWidth(line)).toBeLessThanOrEqual(40);
    }
  });

  it('keeps a spinner line inside one terminal row, however long the path', async () => {
    spinnerHandle.start.mockClear();
    // The regression this pins: clack redraws a spinner with ESC[1G ESC[J,
    // which clears exactly one visual row. A message wider than the
    // terminal wraps, the redraw then clears only the last row, and every
    // frame leaves its predecessor on screen -- the animation becomes a
    // column of identical lines. An unbounded id-plus-source-path did that
    // on a 75-column terminal at 155 characters wide.
    const ui = new PrettyUi(75);
    await ui.transcribing(
      {
        id: '01M1B32H12MK2QZ4MFERJXSH74',
        title: null,
        sourcePath: '/Users/someone/a/deeply/nested/set/of/directories/two-speakers-mixed.wav',
      } as never,
      async () => undefined,
    );
    const message = spinnerHandle.start.mock.calls[0]?.[0] as string;
    // clack prints its own glyph plus two spaces ahead of the message.
    expect(stringWidth(message)).toBeLessThanOrEqual(75 - 3);
    // The filename survives; the leading directories are what get dropped.
    expect(message).toContain('two-speakers-mixed.wav');
    expect(message).toContain('01M1B32H12MK2QZ4MFERJXSH74');
  });

  it('leaves a spinner line that already fits completely alone', async () => {
    spinnerHandle.start.mockClear();
    const ui = new PrettyUi(120);
    await ui.transcribing(
      { id: 'ID001', title: null, sourcePath: '/in/a.wav' } as never,
      async () => undefined,
    );
    expect(spinnerHandle.start.mock.calls[0]?.[0]).toBe('Transcribing ID001  /in/a.wav');
  });

  it('sends the frame to stderr, not stdout', async () => {
    intro.mockClear();
    outro.mockClear();
    const ui = new PrettyUi();
    await ui.frame('show', async () => undefined);
    expect(intro.mock.calls[0]?.[1]).toMatchObject({ output: process.stderr });
    expect(outro.mock.calls[0]?.[1]).toMatchObject({ output: process.stderr });
  });
});

describe('PrettyUi.transcribing', () => {
  it('starts and stops the spinner around a successful task', async () => {
    spinnerHandle.start.mockClear();
    spinnerHandle.stop.mockClear();
    spinnerHandle.error.mockClear();
    const ui = new PrettyUi();
    const result = await ui.transcribing(A_RECORDING, async () => 42);
    expect(result).toBe(42);
    expect(spinnerHandle.start).toHaveBeenCalledTimes(1);
    expect(spinnerHandle.stop).toHaveBeenCalledTimes(1);
    expect(spinnerHandle.error).not.toHaveBeenCalled();
  });

  it('reports a spinner error and rethrows when the task fails', async () => {
    spinnerHandle.start.mockClear();
    spinnerHandle.stop.mockClear();
    spinnerHandle.error.mockClear();
    const ui = new PrettyUi();
    const error = new Error('whisper failed');
    await expect(
      ui.transcribing(A_RECORDING, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(spinnerHandle.error).toHaveBeenCalledTimes(1);
    expect(spinnerHandle.stop).not.toHaveBeenCalled();
  });
});

describe('PrettyUi.recordings', () => {
  it('renders the table under the gutter via log.message, not a nested note() frame', () => {
    log.message.mockClear();
    const ui = new PrettyUi();
    ui.recordings([{ id: 'ID001', durationMs: 2000, language: 'en', preview: 'hi' }]);
    expect(log.message).toHaveBeenCalledTimes(1);
    const rendered = log.message.mock.calls[0]?.[0] as string;
    expect(rendered).toContain('ID001');
  });

  it('does not color the table header red', () => {
    log.message.mockClear();
    const ui = new PrettyUi();
    ui.recordings([{ id: 'ID001', durationMs: 2000, language: 'en', preview: 'hi' }]);
    const rendered = log.message.mock.calls[0]?.[0] as string;
    expect(rendered).not.toContain('\x1b[31m');
  });
});

describe('PrettyUi.recordings at a narrow width', () => {
  const row = {
    id: '01M13X34EXX03J1P429AMEC0R8',
    durationMs: 2000,
    language: 'en',
    preview: 'a preview long enough to matter',
  };

  it('drops the borders rather than wrapping cells inside them', () => {
    log.message.mockClear();
    // The bordered table needs far more than this; a 60-column terminal is
    // ordinary, and the frame must survive it.
    new PrettyUi(60).recordings([row]);
    const rendered = log.message.mock.calls.map((call) => call[0] as string).join('\n');
    expect(rendered).toContain(row.id);
    // The fallback wraps to the terminal, so the preview may be split
    // across lines; join them back before looking for it.
    expect(rendered.split('\n').join(' ').replace(/\s+/g, ' ')).toContain(
      'a preview long enough to matter',
    );
    expect(rendered).not.toContain('\u250c');
    expect(rendered).not.toContain('\u2502');
  });

  it('still draws the table when the width allows it', () => {
    log.message.mockClear();
    new PrettyUi(200).recordings([row]);
    const rendered = log.message.mock.calls[0]?.[0] as string;
    expect(rendered).toContain('\u2502');
    expect(rendered).toContain(row.id);
  });

  it('measures by display width, so wide glyphs are not under-counted', () => {
    log.message.mockClear();
    // Each of these CJK glyphs occupies two terminal columns. Counting code
    // points would call this table narrow enough to fit and then overflow.
    const wide = { ...row, preview: '\u4e00'.repeat(40) };
    new PrettyUi(90).recordings([wide]);
    const rendered = log.message.mock.calls.map((call) => call[0] as string).join('\n');
    expect(rendered).not.toContain('\u250c');
  });

  it('wraps a long preview so no fallback line exceeds the gutter-safe width', () => {
    log.message.mockClear();
    const wide = { ...row, preview: 'a preview '.repeat(20).trim() };
    // 60 columns minus clack's 3-column gutter leaves 57.
    new PrettyUi(60).recordings([wide]);
    const rendered = log.message.mock.calls.map((call) => call[0] as string).join('\n');
    const lines = rendered.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(57);
    }
  });
});

describe('PrettyUi.checks wrapping', () => {
  it('wraps a long detail so every line fits under the gutter, indenting the continuation under the detail column', () => {
    log.success.mockClear();
    log.error.mockClear();
    const longDetail =
      'ffmpeg version 9.0.1 Copyright (c) 2000-2026 the FFmpeg developers built with a very long list of configure options';
    // 75 columns, matching the reported terminal, minus the 3-column gutter
    // leaves 72.
    new PrettyUi(75).checks([{ name: 'ffmpeg', ok: true, detail: longDetail }]);
    // checks() emits through clack's own log.success / log.error so the
    // glyph lands in place of the gutter; whichever fired carries the text.
    const rendered = (log.success.mock.calls[0]?.[0] ?? log.error.mock.calls[0]?.[0]) as string;
    const lines = rendered.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(72);
    }
    // "ok  " (4) + two spaces + "ffmpeg" (6, the only name so nothing to
    // pad) + two spaces = 14 columns of indent, putting the continuation
    // under the detail column. The status dot is not counted: clack draws
    // it in place of the gutter character, outside the message text.
    const indent = ' '.repeat(14);
    expect(lines[1]?.startsWith(indent)).toBe(true);
    expect(lines[1]?.startsWith(`${indent} `)).toBe(false);
  });

  it('wraps a long fix line and indents its continuation under the fix text', () => {
    log.success.mockClear();
    log.error.mockClear();
    const longFix =
      'set stt.whisperCpp.model in the laud config file to a model path that points at a downloaded ggml model file on disk';
    new PrettyUi(75).checks([
      { name: 'whisper model', ok: false, detail: 'not configured', fix: longFix },
    ]);
    // checks() emits through clack's own log.success / log.error so the
    // glyph lands in place of the gutter; whichever fired carries the text.
    const rendered = (log.success.mock.calls[0]?.[0] ?? log.error.mock.calls[0]?.[0]) as string;
    const lines = rendered.split('\n');
    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(72);
    }
    const fixLineIndex = lines.findIndex((line) => line.includes('fix:'));
    expect(fixLineIndex).toBeGreaterThanOrEqual(0);
    expect(fixLineIndex + 1).toBeLessThan(lines.length);
    // '      fix: ' is 11 columns wide.
    const indent = ' '.repeat(11);
    expect(lines[fixLineIndex + 1]?.startsWith(indent)).toBe(true);
  });

  it('hard-wraps a path with no spaces at a narrow 60-column width', () => {
    log.success.mockClear();
    log.error.mockClear();
    const longPath = '/Users/donat/.local/share/laud/models/ggml-small-and-a-much-longer-name.bin';
    new PrettyUi(60).checks([{ name: 'whisper model', ok: true, detail: longPath }]);
    // checks() emits through clack's own log.success / log.error so the
    // glyph lands in place of the gutter; whichever fired carries the text.
    const rendered = (log.success.mock.calls[0]?.[0] ?? log.error.mock.calls[0]?.[0]) as string;
    const lines = rendered.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    // 60 columns minus the 3-column gutter leaves 57.
    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(57);
    }
  });

  it('wraps a path far longer than the terminal into many gutter-safe lines', () => {
    log.success.mockClear();
    log.error.mockClear();
    const longPath = `/Users/donat/${'very-long-directory-name/'.repeat(10)}model.bin`;
    new PrettyUi(80).checks([{ name: 'whisper model', ok: true, detail: longPath }]);
    // checks() emits through clack's own log.success / log.error so the
    // glyph lands in place of the gutter; whichever fired carries the text.
    const rendered = (log.success.mock.calls[0]?.[0] ?? log.error.mock.calls[0]?.[0]) as string;
    const lines = rendered.split('\n');
    expect(lines.length).toBeGreaterThan(3);
    // 80 columns minus the 3-column gutter leaves 77.
    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(77);
    }
  });
});

describe('PrettyUi general messages wrap to the available width', () => {
  it('wraps a long source path reported as already present', () => {
    log.warn.mockClear();
    const longPath = `/Users/donat/${'nested-folder/'.repeat(8)}recording.mp3`;
    new PrettyUi(60).imported({ ...A_RECORDING, sourcePath: longPath }, true);
    const rendered = log.warn.mock.calls[0]?.[0] as string;
    const lines = rendered.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(57);
    }
  });

  it('wraps a long source path reported as freshly imported', () => {
    log.success.mockClear();
    const longPath = `/in/${'x'.repeat(120)}.mp3`;
    new PrettyUi(50).imported({ ...A_RECORDING, sourcePath: longPath }, false);
    const rendered = log.success.mock.calls[0]?.[0] as string;
    const lines = rendered.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(47);
    }
  });

  it('leaves an ordinary-width message on one line', () => {
    log.info.mockClear();
    new PrettyUi(80).emptyLibrary();
    const rendered = log.info.mock.calls[0]?.[0] as string;
    expect(rendered.split('\n')).toHaveLength(1);
    expect(stringWidth(rendered)).toBeLessThanOrEqual(77);
  });
});

describe('PrettyUi.checks distinguishes an optional failure', () => {
  const OPTIONAL_FAILURE = {
    name: 'diarizer binary',
    ok: false as const,
    detail: 'not found on PATH',
    fix: 'install sherpa-onnx',
    optional: true as const,
  };

  it('emits it through log.warn with an "n/a" status, not log.error with "FAIL"', () => {
    log.success.mockClear();
    log.warn.mockClear();
    log.error.mockClear();
    new PrettyUi().checks([
      { name: 'ffmpeg', ok: true, detail: 'version 9.0.1' },
      OPTIONAL_FAILURE,
    ]);
    expect(log.error).not.toHaveBeenCalled();
    const rendered = log.warn.mock.calls[0]?.[0] as string;
    expect(rendered).toContain('n/a');
    expect(rendered).not.toContain('FAIL');
    // The fix still travels with it: it is how a reader turns the feature on.
    expect(rendered).toContain('fix: install sherpa-onnx');
  });

  it('keeps FAIL and log.error for a mandatory failure alongside it', () => {
    log.warn.mockClear();
    log.error.mockClear();
    new PrettyUi().checks([
      OPTIONAL_FAILURE,
      { name: 'whisper model', ok: false, detail: 'not configured', fix: 'set it' },
    ]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]?.[0] as string).toContain('FAIL');
  });

  it('follows the list with one note saying laud can still run', () => {
    log.info.mockClear();
    new PrettyUi().checks([OPTIONAL_FAILURE]);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0]?.[0] as string).toContain('1 optional check');
  });

  it('prints no note when no optional check failed', () => {
    log.info.mockClear();
    new PrettyUi().checks([{ name: 'ffmpeg', ok: true, detail: 'version 9.0.1' }]);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('keeps the status column four columns wide, so names stay aligned', () => {
    log.success.mockClear();
    log.warn.mockClear();
    new PrettyUi().checks([{ name: 'ffmpeg', ok: true, detail: 'v9' }, OPTIONAL_FAILURE]);
    const ok = log.success.mock.calls[0]?.[0] as string;
    const na = log.warn.mock.calls[0]?.[0] as string;
    // Both names are padded to the widest name, so the detail column lands at
    // the same offset on every row regardless of status word.
    expect(ok.indexOf('v9')).toBe(na.indexOf('not found on PATH'));
  });
});
