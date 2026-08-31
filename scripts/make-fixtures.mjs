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
// The same one-voice-per-line mechanism produces the multi-speaker fixtures
// the diarization feature needs: each line is a turn, and giving consecutive
// lines different voices makes a real conversation rather than one voice
// pretending to be several.
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
 * The speaker rotation for a fixture: line `i` of its .txt is spoken by
 * `voices[i % voices.length]`. A one-voice fixture is a monologue; two
 * voices alternate; three take turns in a cycle.
 *
 * Cycling rather than one-voice-per-line keeps a twelve-turn conversation
 * configured as two names instead of twelve, and means lengthening a
 * fixture is purely a matter of adding lines to its .txt.
 * @type {Fixture[]}
 */
const FIXTURES = [
  { name: 'en-short', voices: ['Samantha'] },
  { name: 'ru-short', voices: ['Milena'] },
  { name: 'mixed-short', voices: ['Samantha', 'Milena'] },
  // Diarization fixtures. Voices are picked for CONTRAST, not variety: a
  // speaker-embedding model separates two voices by how different they
  // sound, so a female/male pair is a fair test of the feature while two
  // similar voices would mostly test the model's limits. mixed-short above
  // does technically hold two speakers, but both its voices are female,
  // which is why it is not the fixture to diarize against.
  // Russian carrying English loanwords, all written the way Russians write
  // them -- in Cyrillic. One voice: this is not code-switching, it is one
  // language that has absorbed foreign words, and the distinction matters.
  // Multilingual mode must NOT split these turns, because splitting one is
  // how "дедлайн" gets transcribed as English and comes back as a different
  // word entirely. Transcribing them phonetically in Cyrillic is the correct
  // outcome; substituting an unrelated word is the failure.
  { name: 'ru-anglicisms', voices: ['Milena'] },
  { name: 'two-speakers-en', voices: ['Samantha', 'Daniel'] },
  // Three, because the design spike found speaker-count discovery is the
  // weak spot: two speakers were correct across a wide threshold band,
  // four only inside a narrow one. Three is where that starts to bite.
  { name: 'three-speakers-en', voices: ['Samantha', 'Daniel', 'Fred'] },
  // Two speakers AND two languages, with a male/female contrast. This is
  // the only fixture that exercises --diarize together with
  // --multilingual, which is the composition the diarization design claims
  // works because the two features are independent axes joined by time.
  //
  // Daniel (male) reads the English and Milena (female) the Russian, rather
  // than the other way round, because Milena is the ONLY working ru_RU voice
  // installed. `say -v Yuri` accepts the flag and produces a file, but does
  // not actually speak Russian -- it reads the Cyrillic out as Unicode
  // character names, which transcribed as "Cyrillic letter Ja ..." and made
  // the first version of this fixture useless. Verified by running it.
  { name: 'two-speakers-mixed', voices: ['Daniel', 'Milena'] },
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

/**
 * Silence inserted between turns, in seconds.
 *
 * Without it these files are not conversations. Concatenated `say` output
 * runs one turn straight into the next with no gap at all, and a real
 * exchange never does -- people pause when they hand over. It also matters
 * mechanically: voice-activity detection separates speech from silence, so
 * with no silence to find it returned ONE span for a 36-second twelve-turn
 * file, which made it useless for locating turn boundaries and sent the
 * multilingual code looking for them with fixed-size windows instead.
 *
 * 400ms is a short handover -- long enough for a detector to see, short
 * enough that the exchange still sounds brisk rather than staged.
 */
const TURN_GAP_SECONDS = 0.4;

/** Concatenates two or more same-format WAVs into one, with a gap between turns. */
function concatenate(clauseWavs, outputWav) {
  if (clauseWavs.length === 1) {
    run('ffmpeg', ['-v', 'error', '-y', '-i', clauseWavs[0], '-c', 'copy', outputWav]);
    return;
  }
  const inputArgs = clauseWavs.flatMap((wav) => ['-i', wav]);
  // Each turn is followed by silence except the last: apad adds it, atrim
  // bounds it, so every input contributes its speech plus one gap.
  const padded = clauseWavs
    .map((_, i) =>
      i === clauseWavs.length - 1
        ? `[${i}:a]anull[p${i}]`
        : `[${i}:a]apad=pad_dur=${TURN_GAP_SECONDS}[p${i}]`,
    )
    .join(';');
  const labels = clauseWavs.map((_, i) => `[p${i}]`).join('');
  const filter = `${padded};${labels}concat=n=${clauseWavs.length}:v=0:a=1[out]`;
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
      // Not an equality check: voices cycle. But every configured voice must
      // actually speak, or a typo in the rotation would silently drop a
      // speaker and the fixture would quietly stop testing what it claims to.
      if (lines.length < fixture.voices.length) {
        throw new Error(
          `${fixture.name}.txt has only ${lines.length} line(s) but ${fixture.voices.length} ` +
            'voice(s) are configured, so at least one voice would never speak.',
        );
      }

      console.log(
        `generating ${fixture.name} (${lines.length} turn(s), voices: ` +
          `${fixture.voices.join(', ')})`,
      );
      const clauseWavs = lines.map((line, i) =>
        synthesizeClause(
          scratch,
          `${fixture.name}-${i}`,
          fixture.voices[i % fixture.voices.length],
          line,
        ),
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
