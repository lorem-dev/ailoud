import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATE, SUMMARY_TEMPLATES, findTemplate, templateNames } from './templates.js';

describe('SUMMARY_TEMPLATES', () => {
  it('has a template for the default name', () => {
    expect(findTemplate(DEFAULT_TEMPLATE)).toBeDefined();
  });

  it('gives each kind of conversation its own headings', () => {
    // The point of templates: a 1:1 is about agreements and concerns, an
    // architecture session about which options were weighed. One heading set
    // for both answers neither well.
    const oneOnOne = findTemplate('one-on-one')!;
    const architecture = findTemplate('architecture-planning')!;
    expect(oneOnOne.headings).not.toEqual(architecture.headings);
    expect(oneOnOne.headings).toContain('Concerns raised');
    expect(architecture.headings).toContain('Options considered');
  });

  it('names no template twice', () => {
    const names = SUMMARY_TEMPLATES.map((template) => template.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every template a context sentence and at least two headings', () => {
    for (const template of SUMMARY_TEMPLATES) {
      expect(template.context.trim(), template.name).not.toBe('');
      expect(template.headings.length, template.name).toBeGreaterThanOrEqual(2);
      expect(template.summary.trim(), template.name).not.toBe('');
    }
  });

  it('matches a name case-insensitively and ignores stray spaces', () => {
    expect(findTemplate('One-On-One')?.name).toBe('one-on-one');
    expect(findTemplate('  offsite ')?.name).toBe('offsite');
  });

  it('returns undefined for a name it does not have', () => {
    expect(findTemplate('retrospective')).toBeUndefined();
  });

  it('lists the names for an error message', () => {
    expect(templateNames()).toContain('one-on-one');
    expect(templateNames()).toContain('architecture');
  });
});
