#!/usr/bin/env node
// Regenerates the two artefacts that guard packages/core/src/db/schema.ts
// against a silent edit or an undocumented schema change: schema.lock.json
// (one fingerprint per shipped migration) and schema.snapshot.sql (the
// schema the full migration run produces). Both live in
// packages/providers/src/store because generating them needs node:crypto and
// a real database, and packages/core is not allowed either -- see
// eslint.config.mjs's no-restricted-imports for packages/core/src.
// Read back by packages/providers/src/store/schemaGuard.test.ts.
//
// Usage: pnpm build && node scripts/write-schema-snapshot.mjs
//
// Run this after ADDING a migration, never to make a failure go away about a
// migration that already shipped -- if schemaGuard.test.ts is failing
// because an already-shipped migration changed, the fix is to revert that
// migration, not to run this script. See
// .agents/skills/check-migrations/SKILL.md.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

// Relative into the OTHER package's build output, not through the
// `@ailoud/core` package name: this script runs at the workspace root, which
// depends on neither package, so there is no node_modules/@ailoud symlink for
// that name to resolve through. Requires `pnpm build` to have run first.
import { MIGRATIONS } from '../packages/core/dist/db/schema.js';

const root = dirname(fileURLToPath(import.meta.url));
const storeDir = join(root, '..', 'packages', 'providers', 'src', 'store');
const LOCK = join(storeDir, 'schema.lock.json');
const SNAPSHOT = join(storeDir, 'schema.snapshot.sql');

// Keep in exact step with the same-named function in
// packages/providers/src/store/schemaGuard.test.ts -- both must compute the
// same thing from the same MIGRATIONS, or a passing test there proves
// nothing. Hashes the statements only, never the comments around them in
// schema.ts: those are TypeScript comments outside the template-literal
// strings, never part of `migration.statements` at runtime, and editing one
// must not require touching the lock. A record-separator character (0x1E),
// not ';', goes between statements: a semicolon can appear INSIDE a
// statement (every trigger body in schema.ts has several, between its
// BEGIN...END sub-statements), which would let two different splits of the
// same bytes collide on the same hash. 0x1E cannot appear in any SQL
// statement written in schema.ts, so this join has no such collision.
const FINGERPRINT_SEPARATOR = '\x1e';

function fingerprint(migration) {
  const hash = createHash('sha256');
  for (const statement of migration.statements) {
    hash.update(statement);
    hash.update(FINGERPRINT_SEPARATOR);
  }
  return hash.digest('hex');
}

// Keep in exact step with the same-named function in schemaGuard.test.ts.
// Excludes FTS5's shadow tables (segment_fts_config, _data, _docsize, _idx):
// they are generated internally by the FTS5 extension bundled with whichever
// SQLite build node:sqlite links (still experimental in Node 24, CI pins
// only the major version), not written by any statement in schema.ts, so
// their exact DDL text can change on a Node/SQLite upgrade with zero change
// to any migration -- which would fail this guard for a reason unrelated to
// its subject. `CREATE VIRTUAL TABLE segment_fts` itself is NOT excluded:
// the declaration stays guarded, only its generated implementation detail
// does not.
function dumpSchema(db) {
  const rows = db
    .prepare(
      `SELECT sql FROM sqlite_master
       WHERE sql IS NOT NULL
         AND NOT (type = 'table' AND name LIKE 'segment\\_fts\\_%' ESCAPE '\\')
       ORDER BY type, name`,
    )
    .all();
  return rows.map((row) => `${row.sql};`).join('\n\n') + '\n';
}

const db = new DatabaseSync(':memory:');
try {
  for (const migration of MIGRATIONS) {
    for (const statement of migration.statements) db.exec(statement);
  }

  const lock = {};
  for (const migration of MIGRATIONS) lock[String(migration.version)] = fingerprint(migration);

  writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
  writeFileSync(SNAPSHOT, dumpSchema(db));
} finally {
  db.close();
}

console.log(`Wrote ${LOCK}`);
console.log(`Wrote ${SNAPSHOT}`);
