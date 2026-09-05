#!/usr/bin/env node
// Print one sorted, deduplicated line per command, subcommand or flag
// documented anywhere under docs/ or in README.md.
//
// Usage: node scripts/docs-surface.mjs > surface.txt
//
// This is the safety net for compressing the documentation. Capture this
// output before a prose-cutting pass and after; comm -23 before.txt after.txt
// must print nothing. Anything it does print was documented and is not
// anymore -- only prose may be cut, never a command, subcommand, flag or
// option. See .superpowers/plans/2026-09-06-documentation-mcp-first.md.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSurface } from './lib/docsSurface.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

for (const line of buildSurface(ROOT)) console.log(line);
