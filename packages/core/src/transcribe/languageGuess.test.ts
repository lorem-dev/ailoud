import { describe, expect, it } from 'vitest';
import { guessLanguages } from './languageGuess.js';

describe('guessLanguages', () => {
  it('reads codes out of a filename', () => {
    const guess = guessLanguages({ sourcePath: '/in/2026-08-14-standup-ru-en.m4a' });
    expect(guess?.languages).toEqual(['ru', 'en']);
    expect(guess?.from).toContain('2026-08-14-standup-ru-en.m4a');
  });

  it('reads language names as well as codes', () => {
    expect(guessLanguages({ sourcePath: '/in/interview-russian.wav' })?.languages).toEqual(['ru']);
  });

  it('infers ru from Cyrillic in the name', () => {
    const guess = guessLanguages({
      // Escaped, not literal: source stays ASCII (AGENTS.md, Text and Encoding).
      sourcePath: '/in/sozvon-\u0441-\u043a\u043e\u043c\u0430\u043d\u0434\u043e\u0439.m4a',
    });
    expect(guess?.languages).toEqual(['ru']);
  });

  it('reads the title when the filename says nothing', () => {
    const guess = guessLanguages({ sourcePath: '/in/rec0007.wav', title: 'German kickoff call' });
    expect(guess?.languages).toEqual(['de']);
  });

  it('reads tags too', () => {
    const guess = guessLanguages({ sourcePath: '/in/rec0007.wav', tags: ['lang-en', 'backend'] });
    expect(guess?.languages).toEqual(['en']);
  });

  it('keeps the order it found them in and does not repeat one', () => {
    const guess = guessLanguages({ sourcePath: '/in/en-ru-en-call.wav' });
    expect(guess?.languages).toEqual(['en', 'ru']);
  });

  it('returns null when nothing in the name suggests a language', () => {
    expect(guessLanguages({ sourcePath: '/in/rec0007.wav' })).toBeNull();
  });

  it('does not read a language out of an unrelated word that contains a code', () => {
    // "standup" contains "an"; "rendered" contains "en". Tokens are matched
    // whole, never as substrings, or every filename would guess something.
    expect(guessLanguages({ sourcePath: '/in/standup-rendered.wav' })).toBeNull();
  });

  it('ignores the extension, which is not a language', () => {
    expect(guessLanguages({ sourcePath: '/in/meeting.is' })).toBeNull();
  });

  it('survives a path with no basename at all', () => {
    expect(guessLanguages({ sourcePath: '/' })).toBeNull();
  });
});
