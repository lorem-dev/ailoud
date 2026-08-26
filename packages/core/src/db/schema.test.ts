import { describe, expect, it } from 'vitest';
import { MIGRATIONS, SCHEMA_VERSION, pendingMigrations } from './schema.js';

describe('migrations', () => {
  it('numbers migrations from 1 with no gaps', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
  });

  it('reports the newest version as SCHEMA_VERSION', () => {
    expect(SCHEMA_VERSION).toBe(MIGRATIONS.length);
  });

  it('returns everything for a fresh database', () => {
    expect(pendingMigrations(0)).toHaveLength(MIGRATIONS.length);
  });

  it('returns nothing for a current database', () => {
    expect(pendingMigrations(SCHEMA_VERSION)).toEqual([]);
  });

  it('refuses a database newer than this build', () => {
    expect(() => pendingMigrations(SCHEMA_VERSION + 1)).toThrow(/newer/);
  });
});
