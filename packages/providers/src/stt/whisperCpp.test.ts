import { describe, expect, it, vi } from 'vitest';
import {
  parseDetectedLanguage,
  parseProgressPercent,
  parseWhisperJson,
  WhisperCppProvider,
} from './whisperCpp.js';

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

describe('parseProgressPercent', () => {
  it('reads the line whisper actually prints', () => {
    // Measured against whisper-cli (Homebrew, ggml-small.bin). Note the
    // two spaces of padding before a two-digit number.
    expect(parseProgressPercent('whisper_print_progress_callback: progress =  46%')).toBe(46);
  });

  it('reads an unpadded hundred', () => {
    expect(parseProgressPercent('whisper_print_progress_callback: progress = 100%')).toBe(100);
  });

  it('returns null for any other line rather than throwing', () => {
    for (const line of [
      '',
      'whisper_init_from_file_with_params_no_state: loading model',
      'whisper_print_progress_callback: progress =  ??%',
      'progress = 46',
      'whisper_print_progress_callback: progress =  -1%',
      'whisper_print_progress_callback: progress =  101%',
    ]) {
      expect(parseProgressPercent(line)).toBeNull();
    }
  });
});

describe('WhisperCppProvider', () => {
  it('passes the model, the audio, and the language hint', async () => {
    const runner = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const readFile = vi.fn(async () => WHISPER_OUTPUT);
    const provider = new WhisperCppProvider({
      binary: 'whisper-cli',
      modelPath: '/models/base.bin',
      threads: 4,
      gpu: true,
      runner,
      readFile,
    });

    const result = await provider.transcribe('/tmp/a.wav', { language: 'ru' });

    expect(runner).toHaveBeenCalledWith(
      'whisper-cli',
      [
        '-m',
        '/models/base.bin',
        '-f',
        '/tmp/a.wav',
        '-l',
        'ru',
        '-t',
        '4',
        '-oj',
        '-pp',
        '-of',
        '/tmp/a',
      ],
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
      threads: 4,
      gpu: true,
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
      threads: 4,
      gpu: true,
      runner,
      readFile: async () => WHISPER_OUTPUT,
    });

    const result = await provider.transcribe('/tmp/a.wav', { model: '/models/large.bin' });

    expect(runner).toHaveBeenCalledWith(
      'whisper-cli',
      [
        '-m',
        '/models/large.bin',
        '-f',
        '/tmp/a.wav',
        '-l',
        'auto',
        '-t',
        '4',
        '-oj',
        '-pp',
        '-of',
        '/tmp/a',
      ],
      expect.anything(),
    );
    expect(result.model).toBe('large.bin');
  });

  it('turns a non-zero exit into a failure naming the stderr', async () => {
    const provider = new WhisperCppProvider({
      binary: 'whisper-cli',
      modelPath: '/models/base.bin',
      threads: 4,
      gpu: true,
      runner: async () => ({ code: 1, stdout: '', stderr: 'model load failed' }),
      readFile: async () => '',
    });
    await expect(provider.transcribe('/tmp/a.wav', {})).rejects.toThrow(/model load failed/);
  });

  it.each([
    ['/tmp/ailoud-1.2/audio', '/tmp/ailoud-1.2/audio'],
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
        threads: 4,
        gpu: true,
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
      threads: 4,
      gpu: true,
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
      threads: 4,
      gpu: true,
      runner,
      readFile: async () => '',
    });
    await expect(provider.detectLanguage('/tmp/a.wav')).resolves.toBe('en');
    expect(runner).toHaveBeenCalledWith(
      'whisper-cli',
      ['-m', '/models/small.bin', '-f', '/tmp/a.wav', '-t', '4', '-dl'],
      expect.anything(),
    );
  });

  it('honours an explicit model override for detection too, not just transcription', async () => {
    const runner = vi.fn(async () => ({
      code: 0,
      stdout: '',
      stderr: 'whisper_full_with_state: auto-detected language: en (p = 0.9)',
    }));
    const provider = new WhisperCppProvider({
      binary: 'whisper-cli',
      modelPath: '/models/small.bin',
      threads: 4,
      gpu: true,
      runner,
      readFile: async () => '',
    });
    await provider.detectLanguage('/tmp/a.wav', { model: '/models/large.bin' });
    expect(runner).toHaveBeenCalledWith(
      'whisper-cli',
      ['-m', '/models/large.bin', '-f', '/tmp/a.wav', '-t', '4', '-dl'],
      expect.anything(),
    );
  });

  it('passes -pp so whisper prints progress at all', async () => {
    let seen: readonly string[] = [];
    const provider = new WhisperCppProvider({
      binary: 'whisper-cli',
      modelPath: '/models/m.bin',
      threads: 4,
      gpu: true,
      runner: async (_binary, args) => {
        seen = args;
        return { code: 0, stdout: '', stderr: '' };
      },
      readFile: async () => JSON.stringify({ result: { language: 'en' }, transcription: [] }),
    });
    await provider.transcribe('/tmp/a.wav', {});
    expect(seen).toContain('-pp');
  });

  it('reports whisper progress as a fraction', async () => {
    const seen: number[] = [];
    const provider = new WhisperCppProvider({
      binary: 'whisper-cli',
      modelPath: '/models/m.bin',
      threads: 4,
      gpu: true,
      runner: async (_binary, _args, options) => {
        options?.onStderrLine?.('whisper_print_progress_callback: progress =  46%');
        options?.onStderrLine?.('ggml_metal_init: found device');
        options?.onStderrLine?.('whisper_print_progress_callback: progress = 100%');
        return { code: 0, stdout: '', stderr: '' };
      },
      readFile: async () =>
        JSON.stringify({
          result: { language: 'en' },
          transcription: [{ offsets: { from: 0, to: 10 }, text: ' hi' }],
        }),
    });
    await provider.transcribe('/tmp/a.wav', { onProgress: (f) => seen.push(f) });
    expect(seen).toEqual([0.46, 1]);
  });

  it('transcribes normally when the progress sink throws', async () => {
    const provider = new WhisperCppProvider({
      binary: 'whisper-cli',
      modelPath: '/models/m.bin',
      threads: 4,
      gpu: true,
      runner: async (_binary, _args, options) => {
        options?.onStderrLine?.('whisper_print_progress_callback: progress =  46%');
        return { code: 0, stdout: '', stderr: '' };
      },
      readFile: async () =>
        JSON.stringify({
          result: { language: 'en' },
          transcription: [{ offsets: { from: 0, to: 10 }, text: ' hi' }],
        }),
    });
    const result = await provider.transcribe('/tmp/a.wav', {
      onProgress: () => {
        throw new Error('sink exploded');
      },
    });
    expect(result.segments).toHaveLength(1);
  });
});

describe('resource flags', () => {
  function capture() {
    const runner = vi.fn(async (_command: string, _args: readonly string[]) => ({
      code: 0,
      stdout: '',
      stderr: '',
    }));
    return { runner, args: (): string[] => runner.mock.calls[0]![1] as string[] };
  }

  it('passes the thread count it was given', async () => {
    const { runner, args } = capture();
    const provider = new WhisperCppProvider({
      binary: 'whisper-cli',
      modelPath: '/m.bin',
      threads: 7,
      gpu: true,
      runner,
      readFile: async () => JSON.stringify({ transcription: [{ text: 'hi' }] }),
    });
    await provider.transcribe('/a.wav', {});
    expect(args()).toEqual(expect.arrayContaining(['-t', '7']));
  });

  it('leaves the GPU alone by default, passing no -ng', async () => {
    // MEASURED: a homebrew whisper-cli already loads Metal with no flag from
    // us. -ng would turn that off, so its absence is the feature.
    const { runner, args } = capture();
    const provider = new WhisperCppProvider({
      binary: 'whisper-cli',
      modelPath: '/m.bin',
      threads: 7,
      gpu: true,
      runner,
      readFile: async () => JSON.stringify({ transcription: [{ text: 'hi' }] }),
    });
    await provider.transcribe('/a.wav', {});
    expect(args()).not.toContain('-ng');
  });

  it('passes -ng when the GPU is turned off', async () => {
    const { runner, args } = capture();
    const provider = new WhisperCppProvider({
      binary: 'whisper-cli',
      modelPath: '/m.bin',
      threads: 7,
      gpu: false,
      runner,
      readFile: async () => JSON.stringify({ transcription: [{ text: 'hi' }] }),
    });
    await provider.transcribe('/a.wav', {});
    expect(args()).toContain('-ng');
  });

  it('passes the thread count to language detection too', async () => {
    // detectLanguage loads the same model, and the multilingual path runs it
    // once per unit -- the place where a thread count matters most.
    const runner = vi
      .fn()
      .mockResolvedValue({ code: 0, stdout: 'auto-detected language: ru', stderr: '' });
    const provider = new WhisperCppProvider({
      binary: 'whisper-cli',
      modelPath: '/m.bin',
      threads: 5,
      gpu: true,
      runner,
    });
    await provider.detectLanguage('/a.wav');
    expect(runner.mock.calls[0]![1]).toEqual(expect.arrayContaining(['-t', '5']));
  });

  it('never passes a flag that was measured and rejected', async () => {
    // sherpa's provider flag and llama's -ngl were both measured slower or
    // unmeasurable and dropped. -p stays at whisper's own 1: raising it
    // decodes independent chunks and loses context at every boundary.
    const { runner, args } = capture();
    const provider = new WhisperCppProvider({
      binary: 'whisper-cli',
      modelPath: '/m.bin',
      threads: 7,
      gpu: true,
      runner,
      readFile: async () => JSON.stringify({ transcription: [{ text: 'hi' }] }),
    });
    await provider.transcribe('/a.wav', {});
    expect(args()).not.toContain('-p');
    expect(args()).not.toContain('-ngl');
  });
});
