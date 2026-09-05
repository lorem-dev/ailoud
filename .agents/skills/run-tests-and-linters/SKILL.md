---
name: run-tests-and-linters
description: >
  Install dependencies and run the full TypeScript quality gate: the
  project-references build, a Prettier format check, ESLint, tsc
  typecheck, and Vitest with v8 coverage at 90% (packages/core). Report
  any failures clearly with file paths and line numbers.
---

# run-tests-and-linters

Run the full quality gate for ailoud before marking any task done. `ailoud` is
a pure TypeScript pnpm workspace, so the gate has no Rust or native half to
run alongside it.

## Steps

1. **Ensure dependencies are installed.**

   ```bash
   pnpm install
   ```

   If this fails, report the error and stop -- later steps will not
   produce meaningful results.

2. **Build.**

   ```bash
   pnpm build
   ```

   Cross-package types resolve through dist, so this must run before
   typecheck. A failed build is a blocker.

3. **Run the Prettier format check.**

   ```bash
   pnpm format:check
   ```

   A file that does not match Prettier's formatting is a blocker. Fix with
   `pnpm format`, then re-run the check -- do not hand-edit whitespace to
   chase Prettier.

4. **Run ESLint.**

   ```bash
   pnpm lint
   ```

   Collect any errors or warnings. ESLint errors are blockers; warnings
   should be reported but are not blocking unless the lint script is
   configured to treat them as errors.

5. **Run TypeScript typecheck.**

   ```bash
   pnpm typecheck
   ```

   Any type error is a blocker. Report each error with its file path and
   line number.

6. **Run tests with coverage.**

   ```bash
   pnpm test:cov
   ```

   The Vitest v8 coverage gate requires 90% lines, branches, functions, and
   statements, scoped to `packages/core/src/**/*.ts` (see
   `vitest.config.ts`). `packages/providers` is excluded from the gate and
   is covered by the end-to-end suite (`pnpm test:e2e`) instead. If the
   gate fails:
   - Show the coverage summary table.
   - Identify which files are below threshold.
   - Clearly state that the coverage gate is blocking the task.

7. **Report.**
   Produce a structured summary:

   ```
   build:       PASS / FAIL
   format:      PASS / FAIL (N files need formatting)
   lint:        PASS / FAIL (N errors, N warnings)
   typecheck:   PASS / FAIL (N errors)
   tests:       PASS / FAIL (N failed, N passed)
   coverage:    PASS / FAIL (lines X%, branches X% -- threshold 90%)

   Overall: PASS / FAIL
   ```

   For each failure include the relevant output excerpt so the developer
   can act on it immediately.

   This skill does not run `pnpm test:e2e` -- the end-to-end suite needs a
   real `ffmpeg`, a whisper.cpp binary, and a model file, and is not part
   of this gate or of CI. See `check-fixtures` for how to run and read it.
