#!/usr/bin/env node
// Measures a summary prompt against transcripts whose content we know, across
// several models and several runs each. Prompts are not deterministic: a
// variant that looks good once can fail one run in three, and only repetition
// shows that.
//
// Usage: node scripts/eval-summary-prompt.mjs [--models haiku,sonnet] [--runs 3] [--variants a,b]
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

const CASES = [
  {
    name: 'en-standup',
    file: 'fixtures/summaries/en-standup.txt',
    file2: null,
    header: [
      'Title: Backend standup',
      'Recorded: 2026.08.24 09:30',
      'Tags: standup, backend',
      'Participants: Ann, Ben, Carla',
    ].join('\n'),
    lang: 'en',
    must: [
      { what: 'the 10k-row decision', re: /10[,\s]?000|ten thousand/i },
      { what: 'who owns it', re: /carla/i },
      { what: 'CI slowness deferred', re: /next week|separate|agenda|defer/i },
    ],
    mustNot: [
      { what: 'invented a deadline', re: /\bmonday\b|\bfriday\b/i },
      { what: 'invented a person', re: /\bdave\b|\berik\b/i },
    ],
  },
  {
    name: 'ru-planning',
    file: 'fixtures/summaries/ru-planning.txt',
    file2: null,
    header: [
      'Title: Планирование релиза',
      'Recorded: 2026.08.25 11:00',
      'Tags: release, planning',
      'Participants: Ирина, Павел, Сергей',
    ].join('\n'),
    names: ['Ирина', 'Павел', 'Сергей'],
    lang: 'ru',
    must: [
      { what: 'the release moved to the 2nd', re: /второ|02|2-е|2 (числ|сентяб)/i },
      { what: 'the rollback blocker', re: /откат|блокер/i },
      { what: 'who writes to the client', re: /ирин|сергей/i },
    ],
    mustNot: [{ what: 'invented a person', re: /\bолег\b|\bмария\b/i }],
  },
  {
    name: 'mixed-review',
    file: 'fixtures/summaries/mixed-review.txt',
    file2: null,
    header: [
      'Title: Deploy review',
      'Recorded: 2026.08.26 15:00',
      'Tags: infra',
      'Participants: Daniel, Милена',
    ].join('\n'),
    names: ['Милена', 'Daniel'],
    lang: 'any',
    must: [
      { what: 'rollback time', re: /40|сорок|forty/i },
      { what: 'the tag-swap decision', re: /tag|тег|образ|image|registry/i },
      { what: 'queues deferred', re: /queue|очеред/i },
    ],
    mustNot: [{ what: 'invented a person', re: /\bsergey\b|\banna\b/i }],
  },
  {
    name: 'en-long',
    file: 'fixtures/summaries/en-long.txt',
    file2: null,
    header: [
      'Title: Weekly engineering review',
      'Recorded: 2026.08.27 14:00',
      'Tags: weekly',
      'Participants: Ann, Ben, Carla',
    ].join('\n'),
    lang: 'en',
    must: [
      { what: 'covers an early topic', re: /billing|invoice|refund/i },
      { what: 'covers a late topic', re: /flaky|quarantine|end-to-end/i },
      { what: 'names the owner', re: /ben/i },
    ],
    mustNot: [{ what: 'invented a person', re: /\bdave\b|\berik\b/i }],
  },
  {
    // Several recordings in one request: the model must keep them apart, which
    // is what the per-file header is for.
    name: 'multi',
    file: 'fixtures/summaries/en-standup.txt',
    header: [
      'Title: Backend standup',
      'Recorded: 2026.08.24 09:30',
      'Tags: standup, backend',
      'Participants: Ann, Ben, Carla',
    ].join('\n'),
    file2: 'fixtures/summaries/en-long.txt',
    header2: [
      'Title: Weekly engineering review',
      'Recorded: 2026.08.27 14:00',
      'Tags: weekly',
      'Participants: Ann, Ben, Carla',
    ].join('\n'),
    lang: 'en',
    must: [
      { what: 'the standup fixture decision', re: /10[,\s]?000|ten thousand|fixture/i },
      { what: 'a topic from the weekly', re: /billing|search|on-call|retention|flaky|mobile/i },
      { what: 'tells the two apart', re: /standup/i },
      { what: 'uses the dates or titles', re: /weekly|08\.27|27 aug|august 27/i },
    ],
    mustNot: [{ what: 'invented a person', re: /\bdave\b|\berik\b/i }],
    words: 400,
  },
  {
    // A template with its own headings, plus caller context. The measured
    // guarantee does not transfer from the default shape automatically.
    name: 'one-on-one',
    file: 'fixtures/summaries/en-oneonone.txt',
    file2: null,
    header: [
      'Title: Ann / Ben 1:1',
      'Recorded: 2026.08.28 10:00',
      'Tags: 1on1',
      'Participants: Ann, Ben',
    ].join('\n'),
    lang: 'en',
    template: 'one-on-one',
    callerContext: "Ann is Ben's manager. This is their fortnightly.",
    must: [
      { what: 'the CI handoff agreement', re: /carla|ci|hand(ed|ing)? off/i },
      { what: "Ben's concern about being sole owner", re: /only one|sole|alone|stretched/i },
      { what: 'the missed promotion case', re: /promotion|october|november/i },
      { what: 'uses the template headings', re: /concerns raised/i },
    ],
    mustNot: [
      { what: 'invented a person', re: /\bdave\b|\berik\b/i },
      { what: 'kept the default headings', re: /open questions/i },
    ],
  },
  {
    // No speakers: what an undiarized recording looks like. The instruction to
    // name a speaker per point must not turn into inventing "Speaker A".
    name: 'no-speakers',
    file: 'fixtures/summaries/en-nospeakers.txt',
    file2: null,
    header: [
      'Title: Harbour planning',
      'Recorded: 2026.08.24 09:30',
      'Tags: (none)',
      'Participants: (not identified)',
    ].join('\n'),
    lang: 'en',
    must: [{ what: 'the 5am departure', re: /5\s*(am|a\.m\.|:00)|five/i }],
    mustNot: [
      // Case-sensitive on the label part: "Speaker A" and "speaker_01" are
      // invented labels, while "speaker not identified" is the model being
      // honest. An earlier version of this check conflated the two and
      // reported invention on every run when there was none.
      { what: 'invented a speaker label', re: /\bSpeaker[ _]?[A-Z0-9]\b|speaker_\d/ },
      { what: 'invented a person', re: /\bann\b|\bben\b/i },
      { what: 'noisy per-point disclaimers', re: /(speaker )?not identified|unattributed/i },
      { what: 'closing remark', re: /\n\s*[*_].*participants.*[*_]\s*$/i },
    ],
  },
  {
    // --lang: the output language is asked for, and differs from the
    // transcript's. A model that answers in the transcript's language here
    // has ignored the instruction.
    name: 'ru-into-en',
    file: 'fixtures/summaries/ru-planning.txt',
    file2: null,
    header: [
      'Title: Планирование релиза',
      'Recorded: 2026.08.25 11:00',
      'Tags: release, planning',
      'Participants: Ирина, Павел, Сергей',
    ].join('\n'),
    names: ['Ирина', 'Павел', 'Сергей'],
    lang: 'en',
    forceLang: 'English',
    must: [
      { what: 'the release moved to the 2nd', re: /second|2nd|\b2\b/i },
      { what: 'the rollback blocker', re: /rollback|roll back/i },
    ],
    mustNot: [{ what: 'invented a person', re: /\boleg\b|\bmaria\b/i }],
  },
];

const VARIANTS = {
  // What shipped before this exercise.
  baseline: () =>
    [
      'Summarise the transcript below.',
      'Write in the language the transcript is in.',
      'Lead with what was decided or concluded, if anything was.',
      'Attribute points to the speaker who made them, by the name shown.',
      'Do not invent anything that is not in the transcript.',
    ].join(' '),

  // Numbered rules, explicit output shape, hard length cap.
  rules: (lang) =>
    [
      'Summarise the recording below.',
      '',
      'Rules:',
      `1. Write in ${lang}.`,
      '2. Open with the decisions. If nothing was decided, say "No decisions." and continue.',
      '3. Then the open questions, each with who owns it.',
      '4. Name the speaker for every point, using the names in the transcript.',
      '5. Use only what is in the transcript. Add no advice, context or conclusions of your own.',
      '6. No preamble and no closing line. Under 200 words.',
    ].join('\n'),

  // Same rules, but the shape is spelled out as headings.
  sections: (lang) =>
    [
      'Summarise the recording below.',
      '',
      `Write in ${lang}. Use only what is in the transcript -- no advice, no outside context.`,
      'Name the speaker for every point. No preamble, no closing line, under 200 words.',
      '',
      'Use exactly these headings, omitting any that would be empty:',
      'Decisions',
      'Open questions',
      'Notes',
    ].join('\n'),
  // sections, plus: the header block exists and means something, and the cap
  // scales with how many recordings were handed over.
  headed: (lang, cap, template = TEMPLATES.meeting, callerContext) =>
    [
      'Summarise the recordings below.',
      '',
      template.context,
      ...(callerContext === undefined ? [] : [`Context from the person asking: ${callerContext}`]),
      '',
      'Each transcript starts with a header: its title, when it was recorded, its tags and',
      'who took part. Use them. With more than one recording, say which one a point came from.',
      '',
      `Write in ${lang}.`,
      'Use only what is in the transcripts and the context above -- nothing else you know.',
      'Name the speaker for each point the transcript attributes. Where it attributes none, state',
      'the point on its own -- do not invent a speaker and do not note that there was none.',
      `No preamble, no closing line, no commentary on the transcript. Under ${cap} words.`,
      '',
      'Use exactly these headings, omitting any that would be empty:',
      ...template.headings,
    ].join('\n'),
};

const TEMPLATES = {
  'one-on-one': {
    context:
      'This is a one-to-one between a manager and a report. It is a private conversation: ' +
      'concerns and feelings matter as much as decisions.',
    headings: ['Agreements', 'Concerns raised', 'Follow-ups', 'Notes'],
  },
  meeting: {
    context: 'This is a meeting.',
    headings: ['Decisions', 'Open questions', 'Notes'],
  },
};

const LANG_NAME = { en: 'English', ru: 'Russian', any: 'the language the transcript is in' };

/**
 * The language of the prose, ignoring participant names.
 *
 * Names must be excluded or the measurement is wrong in the one direction that
 * matters: an English summary of a Russian meeting correctly keeps "Ирина" and
 * "Павел", and a naive Cyrillic ratio then calls that summary Russian. The
 * first version of this harness did exactly that and reported --lang as broken
 * on 8 of 9 runs when the outputs were in fact clean English.
 */
function cyrillicRatio(text, names = []) {
  let prose = text;
  for (const name of names) prose = prose.split(name).join(' ');
  const letters = prose.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return 0;
  return letters.filter((c) => /[Ѐ-ӿ]/.test(c)).length / letters.length;
}

function languageOk(text, want, names) {
  const ratio = cyrillicRatio(text, names);
  if (want === 'ru') return ratio > 0.5;
  if (want === 'en') return ratio < 0.05;
  return true;
}

async function ask(model, prompt) {
  const started = Date.now();
  const { stdout } = await run(
    'claude',
    ['--print', '--model', model, '--allowed-tools', '', '--', prompt],
    {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 300_000,
    },
  );
  return { text: stdout.trim(), ms: Date.now() - started };
}

function score(text, testCase) {
  const problems = [];
  if (!languageOk(text, testCase.lang, testCase.names ?? [])) problems.push('wrong language');
  for (const { what, re } of testCase.must) if (!re.test(text)) problems.push(`missing: ${what}`);
  for (const { what, re } of testCase.mustNot)
    if (re.test(text)) problems.push(`hallucinated: ${what}`);
  const words = text.split(/\s+/).filter(Boolean).length;
  const cap = (testCase.words ?? 200) * 1.3;
  if (words > cap) problems.push(`too long: ${words} words`);
  if (/^(here|below|sure|certainly|i'?ll|this is)\b/i.test(text)) problems.push('preamble');
  return { problems, words };
}

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
const models = flag('models', 'haiku,sonnet,opus').split(',');
const runs = Number(flag('runs', '3'));
const variants = flag('variants', Object.keys(VARIANTS).join(',')).split(',');
const only = flag('cases', '');

const cases = only === '' ? CASES : CASES.filter((c) => only.split(',').includes(c.name));
const results = [];

for (const variant of variants) {
  for (const testCase of cases) {
    const parts = [`${testCase.header}\n\n${readFileSync(testCase.file, 'utf8').trim()}`];
    if (testCase.file2)
      parts.push(`${testCase.header2}\n\n${readFileSync(testCase.file2, 'utf8').trim()}`);
    const wantLang = testCase.forceLang ?? LANG_NAME[testCase.lang];
    const cap = testCase.words ?? 200;
    const instruction = VARIANTS[variant](
      wantLang,
      cap,
      TEMPLATES[testCase.template ?? 'meeting'],
      testCase.callerContext,
    );
    const prompt = `${instruction}\n\n${parts
      .map((part, i) => `=== transcript ${i + 1} of ${parts.length} ===\n${part}`)
      .join('\n\n')}`;
    for (const model of models) {
      const jobs = Array.from({ length: runs }, () => ask(model, prompt));
      const settled = await Promise.allSettled(jobs);
      for (const outcome of settled) {
        if (outcome.status === 'rejected') {
          results.push({
            variant,
            case: testCase.name,
            model,
            problems: ['ERROR: ' + outcome.reason.message.slice(0, 80)],
            words: 0,
            ms: 0,
            text: '',
          });
          continue;
        }
        const { text, ms } = outcome.value;
        results.push({ variant, case: testCase.name, model, ...score(text, testCase), ms, text });
      }
      const group = results.filter(
        (r) => r.variant === variant && r.case === testCase.name && r.model === model,
      );
      const clean = group.filter((r) => r.problems.length === 0).length;
      console.log(
        `${variant.padEnd(9)} ${testCase.name.padEnd(13)} ${model.padEnd(7)} ${clean}/${runs} clean`,
      );
      for (const r of group) if (r.problems.length) console.log(`  - ${r.problems.join('; ')}`);
    }
  }
}

console.log('\n=== per variant/model, clean runs over all cases ===');
for (const variant of variants) {
  for (const model of models) {
    const group = results.filter((r) => r.variant === variant && r.model === model);
    const clean = group.filter((r) => r.problems.length === 0).length;
    const avgWords = Math.round(group.reduce((s, r) => s + r.words, 0) / (group.length || 1));
    console.log(
      `${variant.padEnd(9)} ${model.padEnd(7)} ${String(clean).padStart(2)}/${group.length}  avg ${avgWords} words`,
    );
  }
}

if (process.env.DUMP === '1') {
  for (const r of results) {
    console.log(
      `\n########## ${r.variant} / ${r.case} / ${r.model} ${r.problems.length ? '[' + r.problems.join('; ') + ']' : '[clean]'}\n${r.text}`,
    );
  }
}
