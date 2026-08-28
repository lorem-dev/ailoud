import { describe, expect, it, vi } from 'vitest';

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
    expect(outro.mock.calls[0]?.[0]).toContain('done');
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
    expect(outroMessage).toContain('failed');
    expect(outroMessage).toContain('boom');
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
    expect(outro.mock.calls[0]?.[0]).toContain('not an Error');
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
