import { join } from 'node:path';
import type { Command } from 'commander';
import { FailureError, UsageError } from '@laud/core';
import type { CliContext } from '../wiring.js';
import {
  loadTemplate,
  materializeBuiltIns,
  loadTemplates,
  serializeTemplate,
  templatesDir,
  validateTemplateName,
} from '../templateStore.js';

interface NewOptions {
  readonly context?: string;
  readonly heading?: string[];
  readonly summary?: string;
  readonly from?: string;
}

/** Collects a repeated `--heading`, in the order given: headings are ordered. */
function collectHeading(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function registerTemplate(parent: Command, context: CliContext): void {
  const dir = (): string => templatesDir(context.paths.configFile);

  parent
    .command('ls')
    .option('--json', 'print JSON instead of text')
    .description('List summary templates, writing the built-in ones out if they are missing')
    .action(async (options: { readonly json?: boolean }) => {
      await context.ui.frame('Templates', async () => {
        const templates = await loadTemplates(context.fs, dir());
        if (options.json === true) {
          context.ui.content(JSON.stringify(templates));
          return;
        }
        const width = Math.max(...templates.map((template) => template.name.length));
        context.ui.content(
          [
            ...templates.map((template) => `${template.name.padEnd(width)}  ${template.summary}`),
            '',
            `Edit any of these in ${dir()}.`,
          ].join('\n'),
        );
      });
    });

  parent
    .command('show')
    .argument('<name>', 'a template name')
    .description('Print a template as it is stored')
    .action(async (name: string) => {
      await context.ui.frame('Template', async () => {
        const template = await loadTemplate(context.fs, dir(), name);
        if (template === undefined) throw new FailureError(`No template named "${name}".`);
        context.ui.content(
          `${join(dir(), `${template.name}.yaml`)}\n\n${serializeTemplate(template)}`,
        );
      });
    });

  parent
    .command('new')
    .argument('<name>', 'a name in lowercase letters, digits and hyphens')
    .option('--context <text>', 'the sentence telling the model what kind of conversation this is')
    .option('--heading <text>', 'a heading; repeat for each, in order', collectHeading)
    .option('--summary <text>', 'one line describing the template, shown in listings')
    .option('--from <name>', 'start from an existing template instead of empty')
    .description('Create a summary template')
    .action(async (name: string, options: NewOptions) => {
      await context.ui.frame('Creating template', async () => {
        const safe = validateTemplateName(name);
        // The built-ins are written out first, so that a fresh machine knows a
        // shipped name is taken. Without this, `template new one-on-one` on a
        // machine that had never listed templates created a file that shadowed
        // a built-in, silently.
        await materializeBuiltIns(context.fs, dir());
        const path = join(dir(), `${safe}.yaml`);
        if (await context.fs.exists(path)) {
          // Never silently: a template is prose someone wrote, and replacing it
          // without being asked is the same mistake as overwriting a config.
          throw new FailureError(
            `A template named "${safe}" already exists at ${path}. Edit that file, or pick another name.`,
          );
        }

        const base =
          options.from === undefined
            ? undefined
            : await loadTemplate(context.fs, dir(), options.from);
        if (options.from !== undefined && base === undefined) {
          throw new FailureError(`No template named "${options.from}" to start from.`);
        }

        const headings = options.heading ?? base?.headings ?? [];
        const contextLine = options.context ?? base?.context;
        if (contextLine === undefined || contextLine.trim() === '') {
          throw new UsageError(
            'a template needs --context: one sentence saying what kind of conversation it is.',
          );
        }
        if (headings.length < 2) {
          throw new UsageError('a template needs at least two --heading values.');
        }

        await context.fs.ensureDir(dir());
        await context.fs.writeTextFile(
          path,
          serializeTemplate({
            name: safe,
            context: contextLine.trim(),
            headings,
            summary: options.summary ?? base?.summary ?? safe,
          }),
        );
        context.write(`Wrote ${path}`);
        context.write(`Use it with: laud audio summarize <id> --template ${safe}`);
      });
    });
}
