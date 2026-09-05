import { basename, dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { SUMMARY_TEMPLATES, UsageError } from '@laud/core';
import type { Fs, SummaryTemplate } from '@laud/core';

/** Where templates live, beside the config file rather than under the data dir. */
export function templatesDir(configFile: string): string {
  return join(dirname(configFile), 'templates');
}

/**
 * A template as a file: the format someone edits by hand.
 *
 * YAML, matching config.yaml, and with the same field names as the type, so
 * there is nothing to learn twice. `summary` is a one-liner for `--help` and
 * for the MCP tool description; `context` is the sentence handed to the model.
 */
export function serializeTemplate(template: SummaryTemplate): string {
  return stringifyYaml({
    summary: template.summary,
    context: template.context,
    headings: [...template.headings],
  });
}

/** Reads one template file, or explains what is wrong with it. */
export function parseTemplate(name: string, text: string): SummaryTemplate {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new UsageError(
      `template "${name}" is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const fields = (raw ?? {}) as {
    summary?: unknown;
    context?: unknown;
    headings?: unknown;
  };
  const headings = Array.isArray(fields.headings)
    ? fields.headings.filter((h): h is string => typeof h === 'string' && h.trim() !== '')
    : [];
  if (typeof fields.context !== 'string' || fields.context.trim() === '') {
    throw new UsageError(
      `template "${name}" needs a "context" line saying what kind of conversation it is.`,
    );
  }
  if (headings.length < 2) {
    // One heading is not a shape, it is a title. The whole point of a template
    // is that the summary is divided the way this kind of conversation divides.
    throw new UsageError(`template "${name}" needs at least two headings.`);
  }
  return {
    name,
    context: fields.context.trim(),
    headings,
    summary: typeof fields.summary === 'string' ? fields.summary : name,
  };
}

/** `one-on-one`, not `One on One!` -- the name is a file name and a CLI argument. */
export function validateTemplateName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(trimmed)) {
    throw new UsageError(
      `"${name}" is not a usable template name: use lowercase letters, digits and hyphens.`,
    );
  }
  return trimmed;
}

/**
 * Writes the built-in templates into the templates directory, without
 * overwriting anything already there.
 *
 * They are written out rather than kept only in the binary so that they can be
 * read and edited: a template is a piece of prose about how to summarise a
 * kind of conversation, and prose that nobody can see cannot be improved. A
 * file the user has edited is never replaced -- that is the difference between
 * shipping defaults and overwriting someone's work.
 */
export async function materializeBuiltIns(fs: Fs, dir: string): Promise<string[]> {
  await fs.ensureDir(dir);
  const written: string[] = [];
  for (const template of SUMMARY_TEMPLATES) {
    const path = join(dir, `${template.name}.yaml`);
    if (await fs.exists(path)) continue;
    await fs.writeTextFile(path, serializeTemplate(template));
    written.push(template.name);
  }
  return written;
}

/**
 * Every template available, from disk.
 *
 * Disk is the source of truth, with the built-ins written there first, so an
 * edit to a shipped template takes effect and a user's own template is not a
 * second-class citizen. A file that fails to parse is reported rather than
 * skipped: silently ignoring it would look exactly like the template not
 * existing, and the user would go looking in the wrong place.
 */
export async function loadTemplates(fs: Fs, dir: string): Promise<SummaryTemplate[]> {
  await materializeBuiltIns(fs, dir);
  // listFiles hands back full paths, not bare names.
  const paths = (await fs.listFiles(dir))
    .filter((path) => path.endsWith('.yaml'))
    .sort((a, b) => a.localeCompare(b));
  const templates: SummaryTemplate[] = [];
  for (const path of paths) {
    const name = basename(path).replace(/\.yaml$/, '');
    templates.push(parseTemplate(name, await fs.readTextFile(path)));
  }
  return templates;
}

export async function loadTemplate(
  fs: Fs,
  dir: string,
  name: string,
): Promise<SummaryTemplate | undefined> {
  const wanted = name.trim().toLowerCase();
  return (await loadTemplates(fs, dir)).find((template) => template.name === wanted);
}
