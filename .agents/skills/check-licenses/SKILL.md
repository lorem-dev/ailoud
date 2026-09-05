---
name: check-licenses
description: >
  Enumerate direct npm dependencies from every package.json, check each
  license against the acceptable/unacceptable list in CONTRIBUTING.md,
  update the Third-Party Notices section of LICENSE, and fail if any
  dependency carries a disallowed license.
---

# check-licenses

Verify that every direct npm dependency is license-compatible with
Apache-2.0 and keep the Third-Party Notices section of `LICENSE` up to
date. `ailoud` is a pure TypeScript pnpm workspace -- there is no cargo
workspace to check, unlike the source repository this project inherits its
conventions from.

## Steps

1. **Collect all direct dependencies.**

   For each `package.json` in the monorepo (root, `packages/core`,
   `packages/providers`, `apps/cli`), collect the package names under
   `dependencies` and `optionalDependencies`. Do not include
   `devDependencies` (they do not ship to end users).

   ```bash
   pnpm licenses list --prod
   ```

   If that command is unavailable, fall back to reading
   `node_modules/<package>/package.json` for each direct dependency and
   extracting its `license` field, using `pnpm list --prod --depth 0 --json`
   per workspace package to enumerate the direct dependencies.

2. **Check each license against the policy (from CONTRIBUTING.md).**

   NOT acceptable:
   - GPL-2.0, GPL-3.0, AGPL-3.0
   - LGPL-2.1
   - SSPL-1.0, BSL-1.1
   - Any Creative Commons -NC- variant
   - Any license containing a "Commons Clause" addendum

   Acceptable examples (not exhaustive): MIT, BSD-2-Clause, BSD-3-Clause,
   ISC, Apache-2.0, 0BSD, CC0-1.0. A dual license such as `MIT OR
Apache-2.0` is acceptable if at least one of its options is on the
   acceptable list.

3. **Flag any disallowed license.**
   If any dependency carries a disallowed license, report it clearly and
   STOP -- do not update `LICENSE`. The developer must replace or remove
   the dependency before the check can pass.

4. **Build the Third-Party Notices table.**
   For each direct production npm dependency, collect:
   - Package name and version
   - License identifier (SPDX)
   - Copyright line, from `node_modules/<package>/package.json` or the
     package's own LICENSE file

5. **Update LICENSE.**
   Under `## Third-Party Notices`, update ONLY the `### Software
dependencies` subsection's table -- replace from its `| Package |`
   header row to the end of file, keeping the same header and separator
   row:

   ```
   | Package | Ecosystem | Version | License | Copyright |
   |---|---|---|---|---|
   | <name> | npm | <version> | <spdx> | <copyright> |
   ```

   Every row's Ecosystem column is `npm` -- ailoud has no other dependency
   ecosystem. List rows alphabetically by package name. Preserve
   everything above the table verbatim: the Apache 2.0 license text, the
   `## Third-Party Notices` heading, and the intro paragraph above the
   table. Do NOT alter any content above the `### Software dependencies`
   table.

6. **Report.**
   Print the final table and confirm:
   - "All N direct npm dependencies are license-compatible."
   - "LICENSE Third-Party Notices updated."

   Or, if any dependency failed: "BLOCKED: <package> uses <license> which
   is not compatible with Apache 2.0. Replace or remove it before
   merging."
