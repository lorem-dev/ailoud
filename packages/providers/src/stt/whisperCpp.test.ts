import { describe, expect, it, vi } from 'vitest';
import { parseDetectedLanguage, parseWhisperJson, WhisperCppProvider } from './whisperCpp.js';

const WHISPER_OUTPUT = JSON.stringify({
  result: { language: 'ru' },
  transcription: [
    { offsets: { from: 0, to: 1500 }, text: ' Privet.' },
    { offsets: { from: 1500, to: 3200 }, text: ' Kak dela?' },
  ],
});

describe('parseWhisperJson', () => {
  it('maps offsets to segments and trims the text', () => {
    expect(parseWhisperJson(WHISPER_OUTPUT)).toEqual({
      language: 'ru',
      segments: [
        { startMs: 0, endMs: 1500, text: 'Privet.' },
        { startMs: 1500, endMs: 3200, text: 'Kak dela?' },
      ],
    });
  });

  it('drops segments whose text is only whitespace', () => {
    const raw = JSON.stringify({
      result: { language: 'en' },
      transcription: [
        { offsets: { from: 0, to: 100 }, text: '  ' },
        { offsets: { from: 100, to: 200 }, text: ' word' },
      ],
    });
    expect(parseWhisperJson(raw).segments).toHaveLength(1);
  });

  it('falls back to "unknown" when no language is reported', () => {
    const raw = JSON.stringify({ transcription: [] });
    expect(parseWhisperJson(raw).language).toBe('unknown');
  });

  it('rejects output that is not whisper JSON', () => {
    expect(() => parseWhisperJson('{"nope":1}')).toThrow(/transcription/);
  });
});

describe('parseDetectedLanguage', () => {
  it('reads the language out of whisper output', () => {
    const output = [
      'load_backend: loaded BLAS backend from /opt/homebrew/lib/libggml-blas.so',
      'whisper_full_with_state: auto-detected language: ru (p = 0.976)',
    ].join('\n');
    expect(parseDetectedLanguage(output)).toBe('ru');
  });

  it('rejects output with no detection line', () => {
    expect(() => parseDetectedLanguage('load_backend: loaded BLAS backend')).toThrow(/detect/i);
  });
});

describe('WhisperCppProvider', () => {
  it('passes the model, the audio, and the language hint', async () => {
    const runner = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const readFile = vi.fn(async () => WHISPER_OUTPUT);
    const provider = new WhisperCppProvider({
      binary: 'whisper-cli',
      modelPath: '/models/base.bin',
      runner,
      readFile,
    });

    const result = await provider.transcribe('/tmp/a.wav', { language: 'ru' });

    expect(runner).toHaveBeenCalledWith(
      'whisper-cli',
      ['-m', '/models/base.bin', '-f', '/tmp/a.wav', '-l', 'ru', '-oj', '-of', '/tmp/a'],
      expect.anything(),
    );
    expect(result.language).toBe('ru');
    expect(result.model).toBe('base.bin');
    expect(result.segments).toHaveLength(2);
  });

  it('sends "auto" when no language is given', async () => {
    const runner = vi.fn(async (_command: string, _args: readonly string[]) => ({
      code: 0,
      stdout: '',
      stderr: '',
    }));
    const provider = new WhisperCppProvider({
      binary: 'whisper-cli',
      modelPath: '/models/base.bin',
      runner,
      readFile: async () => WHISPER_OUTPUT,
    });
    await provider.transcribe('/tmp/a.wav', {});
    expect(runner.mock.calls[0]![1]).toContain('auto');
  });

  it('honours an explicit model override and reports it as the model used', async () => {
    const runner = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const provider = new WhisperCppProvider({
      binary: 'whisper-cli',
      modelPath: '/models/base.bin',
      runner,
      readFile: async () => WHISPER_OUTPUT,
    });

    const result = await provider.transcribe('/tmp/a.wav', { model: '/models/large.bin' });

    expect(runner).toHaveBeenCalledWith(
      'whisper-cli',
      ['-m', '/models/large.bin', '-f', '/tmp/a.wav', '-l', 'auto', '-oj', '-of', '/tmp/a'],
      expect.anything(),
    );
    expect(result.model).toBe('large.bin');
  });

  it('turns a non-zero exit into a failure naming the stderr', async () => {
    const provider = new WhisperCppProvider({
      binary: 'whisper-cli',
      modelPath: '/models/base.bin',
      runner: async () => ({ code: 1, stdout: '', stderr: 'model load failed' }),
      readFile: async () => '',
    });
    await expect(provider.transcribe('/tmp/a.wav', {})).rejects.toThrow(/model load failed/);
  });

  it.each([
    ['/tmp/laud-1.2/audio', '/tmp/laud-1.2/audio'],
    ['/tmp/a', '/tmp/a'],
    ['/tmp/dir.v2/clip.wav', '/tmp/dir.v2/clip'],
  ])(
    'derives the -of base from the filename only, not any dot in the path (%s)',
    async (audioPath, expectedBase) => {
      const runner = vi.fn(async (_command: string, _args: readonly string[]) => ({
        code: 0,
        stdout: '',
        stderr: '',
      }));
      const provider = new WhisperCppProvider({
        binary: 'whisper-cli',
        modelPath: '/models/base.bin',
        runner,
        readFile: async () => WHISPER_OUTPUT,
      });

      await provider.transcribe(audioPath, {});

      const args = runner.mock.calls[0]![1];
      const ofIndex = args.indexOf('-of');
      expect(args[ofIndex + 1]).toBe(expectedBase);
    },
  );

  it('turns a missing output file into a FailureError, not a bare ENOENT', async () => {
    const provider = new WhisperCppProvider({
      binary: 'whisper-cli',
      modelPath: '/models/base.bin',
      runner: async () => ({ code: 0, stdout: '', stderr: '' }),
      readFile: async () => {
        throw new Error('ENOENT: no such file or directory');
      },
    });
    await expect(provider.transcribe('/tmp/a.wav', {})).rejects.toThrow(/reported success/);
  });

  it('asks whisper to detect without transcribing', async () => {
    const runner = vi.fn(async () => ({
      code: 0,
      stdout: '',
      stderr: 'whisper_full_with_state: auto-detected language: en (p = 0.9)',
    }));
    const provider = new WhisperCppProvider({
      binary: 'whisper-cli',
      modelPath: '/models/small.bin',
      runner,
      readFile: async () => '',
    });
    await expect(provider.detectLanguage('/tmp/a.wav')).resolves.toBe('en');
    expect(runner).toHaveBeenCalledWith(
      'whisper-cli',
      ['-m', '/models/small.bin', '-f', '/tmp/a.wav', '-dl'],
      expect.anything(),
    );
  });
});
