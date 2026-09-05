import { describe, expect, it } from 'vitest';
import { MemFs } from '@laud/core/testing';
import { SUMMARY_TEMPLATES, UsageError } from '@laud/core';
import {
  loadTemplate,
  loadTemplates,
  materializeBuiltIns,
  parseTemplate,
  serializeTemplate,
  templatesDir,
  validateTemplateName,
} from './templateStore.js';

const DIR = '/config/laud/templates';

describe('templatesDir', () => {
  it('sits beside the config file, not under the data directory', () => {
    // A template is configuration -- prose about how to summarise -- not
    // library data.
    expect(templatesDir('/config/laud/config.yaml')).toBe('/config/laud/templates');
  });
});

describe('serializeTemplate / parseTemplate', () => {
  it('round-trips every built-in', () => {
    for (const template of SUMMARY_TEMPLATES) {
      const parsed = parseTemplate(template.name, serializeTemplate(template));
      expect(parsed, template.name).toEqual(template);
    }
  });

  it('takes the name from the file, not from inside it', () => {
    // The file name is the name. Two sources for one fact would drift.
    const parsed = parseTemplate('my-shape', 'context: A chat.\nheadings: [One, Two]\n');
    expect(parsed.name).toBe('my-shape');
  });

  it('refuses a template with no context, naming it', () => {
    expect(() => parseTemplate('broken', 'headings: [One, Two]\n')).toThrow(UsageError);
    expect(() => parseTemplate('broken', 'headings: [One, Two]\n')).toThrow(/"broken"/);
  });

  it('refuses fewer than two headings', () => {
    // One heading is a title, not a shape; the point of a template is that the
    // summary is divided the way this kind of conversation divides.
    expect(() => parseTemplate('thin', 'context: A chat.\nheadings: [Only]\n')).toThrow(
      /at least two headings/,
    );
  });

  it('drops blank headings rather than emitting an empty one', () => {
    expect(
      parseTemplate('x', 'context: A chat.\nheadings: [One, "", "   ", Two]\n').headings,
    ).toEqual(['One', 'Two']);
  });

  it('says the file is not YAML rather than throwing a parser error', () => {
    expect(() => parseTemplate('bad', 'headings: [unclosed\n')).toThrow(/not valid YAML/);
  });

  it('falls back to the name when there is no summary line', () => {
    expect(parseTemplate('x', 'context: A chat.\nheadings: [One, Two]\n').summary).toBe('x');
  });
});

describe('validateTemplateName', () => {
  it('lowercases and accepts hyphens', () => {
    expect(validateTemplateName(' One-On-One ')).toBe('one-on-one');
  });

  it('refuses anything that is not a usable file name', () => {
    for (const bad of ['../escape', 'has space', 'has/slash', '', '-leading']) {
      expect(() => validateTemplateName(bad), bad).toThrow(UsageError);
    }
  });
});

describe('materializeBuiltIns', () => {
  it('writes every built-in as a file someone can read and edit', async () => {
    const fs = new MemFs({});
    const written = await materializeBuiltIns(fs, DIR);
    expect(written).toEqual(SUMMARY_TEMPLATES.map((t) => t.name));
    expect(await fs.exists(`${DIR}/one-on-one.yaml`)).toBe(true);
  });

  it('never overwrites a file the user has edited', async () => {
    // The difference between shipping defaults and destroying someone's work.
    const fs = new MemFs({});
    await materializeBuiltIns(fs, DIR);
    await fs.writeTextFile(`${DIR}/one-on-one.yaml`, 'context: Mine.\nheadings: [A, B]\n');
    const second = await materializeBuiltIns(fs, DIR);
    expect(second).not.toContain('one-on-one');
    expect(await fs.readTextFile(`${DIR}/one-on-one.yaml`)).toContain('Mine.');
  });
});

describe('loadTemplates', () => {
  it('finds the built-ins on a fresh machine, having written them first', async () => {
    const fs = new MemFs({});
    const names = (await loadTemplates(fs, DIR)).map((t) => t.name);
    expect(names).toContain('performance-review');
    expect(names).toContain('solution-decision');
  });

  it('honours an edit to a shipped template', async () => {
    // Disk is the source of truth, or editing the file would do nothing.
    const fs = new MemFs({});
    await materializeBuiltIns(fs, DIR);
    await fs.writeTextFile(
      `${DIR}/one-on-one.yaml`,
      'context: A private chat.\nheadings: [Mine, Yours]\n',
    );
    expect((await loadTemplate(fs, DIR, 'one-on-one'))?.headings).toEqual(['Mine', 'Yours']);
  });

  it('picks up a template the user added, as a peer of the built-ins', async () => {
    const fs = new MemFs({});
    await materializeBuiltIns(fs, DIR);
    await fs.writeTextFile(
      `${DIR}/retro.yaml`,
      'context: A retro.\nheadings: [Went well, Did not]\n',
    );
    expect((await loadTemplates(fs, DIR)).map((t) => t.name)).toContain('retro');
  });

  it('reports a broken file rather than skipping it', async () => {
    // Silently ignoring it looks exactly like the template not existing, and
    // sends the user looking in the wrong place.
    const fs = new MemFs({});
    await materializeBuiltIns(fs, DIR);
    await fs.writeTextFile(`${DIR}/broken.yaml`, 'headings: [One]\n');
    await expect(loadTemplates(fs, DIR)).rejects.toThrow(/"broken"/);
  });

  it('ignores files that are not templates', async () => {
    const fs = new MemFs({});
    await materializeBuiltIns(fs, DIR);
    await fs.writeTextFile(`${DIR}/README.md`, 'not a template');
    await expect(loadTemplates(fs, DIR)).resolves.toBeDefined();
  });

  it('returns undefined for a name that is not there', async () => {
    const fs = new MemFs({});
    expect(await loadTemplate(fs, DIR, 'nope')).toBeUndefined();
  });
});
