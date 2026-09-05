---
name: check-migrations
description: >
  After touching packages/core/src/db/schema.ts -- verify a new migration
  carries a lock entry and an up-to-date snapshot, and judge the one thing
  the guard tests cannot see: whether an edited migration has already
  shipped.
---

# check-migrations

`MIGRATIONS` in `packages/core/src/db/schema.ts` is append-only: every entry
that has reached a released version is a promise to every database that has
already run it. Two tests in
`packages/providers/src/store/schemaGuard.test.ts` enforce most of that
promise mechanically. This skill runs them, reads what they show you, and
judges the part they structurally cannot: whether a migration you are
looking at has shipped.

## When to use it

After any change to `packages/core/src/db/schema.ts` -- a new migration, or
an edit to an existing one -- before it goes into a commit.

## What the guard cannot see

A test can hash a migration and compare it to a database dump. Neither can
tell you when the migration was written. That is the whole reason this is a
skill and not a third test:

- **Editing a migration that has not shipped yet is fine.** If it was added
  in this branch and nothing has run it, changing it is just editing a
  patch before it lands -- update the lock and the snapshot together with
  the edit, in the same commit.
- **Editing a migration that has already shipped is not fine**, no matter
  how small the change. A database that ran it at an older version will
  never run it again, so an edited version means two machines at the same
  `user_version` with different schemas -- and neither the fingerprint test
  nor the snapshot test can tell you this from the file alone, because both
  only ever see the current content of `schema.ts`.
- **Only git history tells the two apart.** Before touching an existing
  migration entry, run:

  ```bash
  git log --oneline -- packages/core/src/db/schema.ts
  ```

  and check whether the commit that introduced this migration's `version`
  has been released (tagged, merged to `main` and shipped) or is still
  local to the current branch. If it has shipped, the change belongs in a
  **new** migration with the next version number, never as an edit to the
  old one -- even to fix a typo in a column name.

## Steps

1. **Run the two tests.**

   ```bash
   pnpm build
   NODE_OPTIONS=--disable-warning=ExperimentalWarning pnpm vitest run packages/providers/src/store/schemaGuard.test.ts
   ```

2. **If "has a lock entry for every migration, and no extras" fails:**
   A migration was added or removed without regenerating the lock. Run:

   ```bash
   node scripts/write-schema-snapshot.mjs
   ```

   then re-run the test. This is safe whenever the mismatch is a missing or
   extra entry -- it is never safe to run this just because the fingerprint
   test below is failing on a migration that has already shipped.

3. **If "still matches the fingerprint of every shipped migration" fails:**
   Read which migration's fingerprint changed and check git history per the
   section above.
   - Unshipped: run `node scripts/write-schema-snapshot.mjs` to update the
     lock, and continue.
   - Shipped: do not regenerate anything. Revert the edit to that migration
     and put the intended change in a new migration instead.

4. **If "produces exactly the snapshotted schema" fails:** read the diff
   Vitest prints between the snapshotted schema and the one the migrations
   now produce. Confirm the diff is exactly the change you intended -- a new
   table, an added column, an added trigger -- and nothing incidental (for
   example a different SQLite version rewriting an unrelated table's
   `CREATE` text). Once confirmed, run:

   ```bash
   node scripts/write-schema-snapshot.mjs
   ```

   and re-run the test.

5. **For a genuinely new migration, confirm the comment.** Every existing
   migration explains, in a comment above its statements, why the table or
   column exists rather than merely what it is. Read the new migration and
   confirm it carries one too -- the guard tests cannot check this, because
   the comment lives outside the hashed statement strings by design (see
   the comment on `fingerprint` in `schemaGuard.test.ts`).

6. **Re-run the whole gate.** `schemaGuard.test.ts` is one file among many;
   finish with the `run-tests-and-linters` skill before calling the change
   done.

## Report

```
schemaGuard.test.ts:      PASS / FAIL
lock regenerated:         yes / no
snapshot regenerated:     yes / no
new migration comment:    present / missing
shipped migration edited: yes (blocking) / no
```

If a shipped migration was edited, say so plainly and do not propose
regenerating the lock as the fix -- the fix is a new migration.
