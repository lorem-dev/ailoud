#!/usr/bin/env node
// Generate the audio fixtures for the end-to-end suite (Task 17).
//
// Uses the macOS `say` binary to synthesize speech, then `ffmpeg` to bring
// it to a plain mono WAV. `say` exists only on macOS, so this script is
// not part of any gate and is not expected to run in CI -- it is run once,
// by hand, and its *output* (the .wav files under fixtures/) is committed
// so the suite can run on any machine that has the built binary, with or
// without `say`.
//
// The reference transcripts already live in fixtures/<name>.txt, committed
// ahead of this script. This script reads them rather than embedding the
// prompt text here, so this file -- source, not data -- stays ASCII-only
// even for the Russian fixture.
//
// A fixture's .txt file holds one clause per line. Most fixtures are one
// line, spoken by one voice. mixed-short.txt has two: an English clause and
// a Russian clause, each synthesized with its own voice, then concatenated
// with ffmpeg into a single clip -- genuinely code-switched audio, not one
// voice reading a sentence that merely contains foreign-origin words.
//
// Usage: node scripts/make-fixtures.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = join(root, 'fixtures');

/**
 * @typedef {{ name: string, voices: string[] }} Fixture
 */

/**
 * One voice per line of the fixture's .txt file, in order. en-short and
 * ru-short have one line each; mixed-short has two, so it gets two voices.
 * @type {Fixture[]}
 */
const FIXTURES = [
  { name: 'en-short', voices: ['Samantha'] },
  { name: 'ru-short', voices: ['Milena'] },
  { name: 'mixed-short', voices: ['Samantha', 'Milena'] },
];

// Generous, not tight: these clips are a few seconds of speech each, but a
// loaded machine (or a cold-start speech-synthesis voice download) can take
// a while, and a hang here should still end the script rather than run
// forever.
const COMMAND_TIMEOUT_MS = 30_000;

function run(command, args) {
  execFileSync(command, args, {
    stdio: ['ignore', 'ignore', 'inherit'],
    timeout: COMMAND_TIMEOUT_MS,
  });
}

/** Synthesizes one line of text with one voice, as a mono 16 kHz WAV. */
function synthesizeClause(scratch, id, voice, text) {
  const aiff = join(scratch, `${id}.aiff`);
  const wav = join(scratch, `${id}.wav`);
  run('say', ['-v', voice, '-o', aiff, text]);
  run('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-i',
    aiff,
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    wav,
  ]);
  return wav;
}

/** Concatenates two or more same-format WAVs into one, in order. */
function concatenate(clauseWavs, outputWav) {
  if (clauseWavs.length === 1) {
    run('ffmpeg', ['-v', 'error', '-y', '-i', clauseWavs[0], '-c', 'copy', outputWav]);
    return;
  }
  const inputArgs = clauseWavs.flatMap((wav) => ['-i', wav]);
  const labels = clauseWavs.map((_, i) => `[${i}:a]`).join('');
  const filter = `${labels}concat=n=${clauseWavs.length}:v=0:a=1[out]`;
  run('ffmpeg', [
    '-v',
    'error',
    '-y',
    ...inputArgs,
    '-filter_complex',
    filter,
    '-map',
    '[out]',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    outputWav,
  ]);
}

function main() {
  const scratch = mkdtempSync(join(tmpdir(), 'laud-fixtures-'));
  try {
    for (const fixture of FIXTURES) {
      const txt = join(fixturesDir, `${fixture.name}.txt`);
      const lines = readFileSync(txt, 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.trim());
      if (lines.length !== fixture.voices.length) {
        throw new Error(
          `${fixture.name}.txt has ${lines.length} line(s) but ${fixture.voices.length} ` +
            'voice(s) are configured for it -- keep them in step.',
        );
      }

      console.log(`generating ${fixture.name} (voices: ${fixture.voices.join(', ')})`);
      const clauseWavs = lines.map((line, i) =>
        synthesizeClause(scratch, `${fixture.name}-${i}`, fixture.voices[i], line),
      );
      const wav = join(fixturesDir, `${fixture.name}.wav`);
      concatenate(clauseWavs, wav);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log('done. Review fixtures/*.wav and commit them (they go through Git LFS).');
}

main();
