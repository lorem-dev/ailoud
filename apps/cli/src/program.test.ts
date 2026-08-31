import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';
import { EnvironmentError, FailureError, UsageError } from '@laud/core';
import {
  FakeAudioTool,
  FakeClock,
  FakeDiarizer,
  FakeIds,
  FakeSegmenter,
  FakeStt,
  MemFs,
} from '@laud/core/testing';
import { SqliteStore } from '@laud/providers';
import { buildProgram, exitCodeFor } from './program.js';
import type { CliContext } from './wiring.js';
import { PlainUi } from './ui/plain.js';

describe('exitCodeFor', () => {
  it('maps each domain error to its documented code', () => {
    expect(exitCodeFor(new FailureError('x'))).toBe(1);
    expect(exitCodeFor(new UsageError('x'))).toBe(2);
    expect(exitCodeFor(new EnvironmentError('x'))).toBe(3);
  });

  it('maps an unexpected error to 1', () => {
    expect(exitCodeFor(new Error('x'))).toBe(1);
  });

  it('maps a commander usage failure to 2', () => {
    const commanderError = Object.assign(new Error('unknown option'), {
      code: 'commander.unknownOption',
    });
    expect(exitCodeFor(commanderError)).toBe(2);
  });

  it('trusts commander help and version exits as 0, not a usage failure', () => {
    const help = Object.assign(new Error('(outputHelp)'), {
      code: 'commander.helpDisplayed',
      exitCode: 0,
    });
    expect(exitCodeFor(help)).toBe(0);
    const version = Object.assign(new Error('1.2.3'), {
      code: 'commander.version',
      exitCode: 0,
    });
    expect(exitCodeFor(version)).toBe(0);
    // An explicit `laud help` also carries the code 'commander.help', but
    // commander itself reports that one as a clean exit (its own exitCode
    // is 0), unlike the no-subcommand case below which shares the same code
    // string but is a usage error.
    const explicitHelp = Object.assign(new Error('(outputHelp)'), {
      code: 'commander.help',
      exitCode: 0,
    });
    expect(exitCodeFor(explicitHelp)).toBe(0);
  });

  it('does not key off the code string for commander.help: same code, different verdict', () => {
    // Reproduced against commander@15.0.0: running a program with a
    // registered subcommand and no arguments raises 'commander.help' with
    // exitCode 1 -- it is a usage error of the same class as a missing
    // argument, not a clean exit, even though the code string is identical
    // to the one an explicit `laud help` raises with exitCode 0.
    const noSubcommand = Object.assign(new Error('(outputHelp)'), {
      code: 'commander.help',
      exitCode: 1,
    });
    expect(exitCodeFor(noSubcommand)).toBe(2);
  });

  it("remaps every other commander usage code to 2, regardless of commander's own exitCode", () => {
    // All of these carry commander's own default exitCode of 1 (verified
    // against commander@15.0.0); this project's convention wants 2.
    for (const code of [
      'commander.unknownOption',
      'commander.unknownCommand',
      'commander.missingArgument',
      'commander.excessArguments',
      'commander.invalidArgument',
      'commander.missingMandatoryOptionValue',
      'commander.optionMissingArgument',
    ]) {
      const error = Object.assign(new Error(code), { code, exitCode: 1 });
      expect(exitCodeFor(error)).toBe(2);
    }
  });

  it('does not assume the thrown value is an object', () => {
    expect(exitCodeFor('boom')).toBe(1);
    expect(exitCodeFor(null)).toBe(1);
    expect(exitCodeFor(undefined)).toBe(1);
  });
});

describe('buildProgram', () => {
  const stores: SqliteStore[] = [];

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  function makeContext(write: (line: string) => void = () => {}): CliContext {
    const store = SqliteStore.open(':memory:');
    stores.push(store);
    return {
      paths: {
        configFile: '/fake/config.yaml',
        dataDir: '/fake/data',
        dbFile: ':memory:',
        mediaRoot: '/fake/data/media',
      },
      config: {
        stt: {
          provider: 'whisper-cpp',
          whisperCpp: {
            binary: 'whisper-cli',
            model: null,
            vadBinary: 'whisper-vad-speech-segments',
            vadModel: null,
          },
          diarization: {
            binary: 'sherpa-onnx-offline-speaker-diarization',
            segmentationModel: null,
            embeddingModel: null,
            threshold: 0.6,
            threads: 4,
          },
        },
        llm: parseConfig(null).llm,
      },
      store,
      fs: new MemFs(),
      audio: new FakeAudioTool(),
      clock: new FakeClock(),
      ids: new FakeIds(),
      write,
      ui: new PlainUi(write),
      createStt: () => new FakeStt({ language: 'en', model: 'fake', segments: [] }),
      createSegmenter: () => new FakeSegmenter([{ startMs: 0, endMs: 1000 }]),
      createDiarizer: () => new FakeDiarizer([]),
      createSummarizer: () => ({
        name: 'fake',
        model: 'fake-model',
        contextTokens: 8192,
        complete: async () => 'x',
      }),
    };
  }

  it('names, describes, and versions the program', () => {
    const program = buildProgram(makeContext());
    expect(program.name()).toBe('laud');
    expect(program.description()).toContain('audio-to-text');
  });

  it('throws instead of exiting the process on an unknown flag', async () => {
    const program = buildProgram(makeContext());
    await expect(program.parseAsync(['node', 'laud', '--bogus'])).rejects.toMatchObject({
      code: 'commander.unknownOption',
    });
  });

  it('maps an unknown flag to exit code 2 end to end', async () => {
    const program = buildProgram(makeContext());
    const error: unknown = await program
      .parseAsync(['node', 'laud', '--bogus'])
      .catch((caught: unknown) => caught);
    expect(exitCodeFor(error)).toBe(2);
  });

  it('writes help text through context.write and maps it to exit code 0 end to end', async () => {
    const lines: string[] = [];
    const program = buildProgram(makeContext((line) => lines.push(line)));
    const error: unknown = await program
      .parseAsync(['node', 'laud', '--help'])
      .catch((caught: unknown) => caught);
    expect(lines.join('\n')).toContain('Usage:');
    expect(exitCodeFor(error)).toBe(0);
  });

  it('maps running with a subcommand attached but no arguments to exit code 2, not 1', async () => {
    // buildProgram already attaches subcommands (import, transcribe, ls,
    // show, doctor), and with a subcommand registered, running `laud` with
    // no arguments and no default action makes commander print help and
    // raise 'commander.help' with its own exitCode of 1. That is a usage
    // error (nothing was told what to do), not a normal failure, so it must
    // map to 2 here, not fall through as 1.
    const program = buildProgram(makeContext());
    const error: unknown = await program
      .parseAsync(['node', 'laud'])
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'commander.help' });
    expect(exitCodeFor(error)).toBe(2);
  });
});
