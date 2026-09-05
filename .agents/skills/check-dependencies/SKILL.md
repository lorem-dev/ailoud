---
name: check-dependencies
description: >
  Audit npm dependencies for known vulnerabilities, report who asks for
  funding, and update what is behind -- refusing any version published less
  than 14 days ago unless it fixes a critical advisory. Run before every
  release and after any dependency change.
---

# check-dependencies

Three questions, in this order: is anything we depend on known to be
vulnerable, who is asking to be paid for it, and what should be updated.
Updating comes last because the first two decide what an update is for.

## Steps

1. **Look for known vulnerabilities.**

   ```bash
   pnpm audit            # everything, including the dev toolchain
   pnpm audit --prod     # only what the three published packages ship
   ```

   Read them separately. A high-severity advisory in a test runner is a
   different problem from one in `commander`: the first cannot reach a user,
   the second is installed on their machine. Fix the `--prod` findings first
   and say which list a finding came from.

2. **Report funding.**

   ```bash
   npm fund
   ```

   `pnpm` has no `fund` command; `npm fund` reads the installed tree and works
   in this workspace. The list is long and almost all of it is the dev
   toolchain. What is worth surfacing is the intersection with what actually
   ships:

   ```bash
   npm fund --json | node -e '
     let s = "";
     process.stdin.on("data", (d) => (s += d)).on("end", () => {
       const names = [];
       const rec = (n) => {
         for (const [name, child] of Object.entries(n.dependencies ?? {})) {
           names.push(name);
           rec(child);
         }
       };
       rec(JSON.parse(s));
       const runtime = new Set();
       for (const p of ["packages/core", "packages/providers", "apps/cli"]) {
         Object.keys(require(`./${p}/package.json`).dependencies ?? {}).forEach((k) =>
           runtime.add(k),
         );
       }
       console.log(names.filter((n) => runtime.has(n)).join(", ") || "(none)");
     })'
   ```

   Report the count and that intersection. Do not open funding pages or
   install anything.

3. **See what is behind.**

   ```bash
   pnpm outdated -r
   ```

   Nothing here is urgent by default. A version bump is worth taking when it
   fixes something this project hits, closes an advisory from step 1, or keeps
   a major version from drifting far enough to become a project of its own.
   "It is newer" is not a reason.

4. **Apply the 14-day rule BEFORE updating anything.**

   ```bash
   node scripts/check-dependency-age.mjs
   ```

   A compromised release is discovered by other people, and that takes days --
   every npm supply-chain incident in recent memory was caught within a week
   or two of publication, after everyone who upgraded immediately had already
   installed it. Waiting costs nothing: there is no urgency in a patch that
   has been out for two weeks that was not there on day one.

   So a candidate version younger than 14 days is not taken. Pin the previous
   one and come back to it.

   **Unless it fixes a critical or high advisory.** Then waiting is the worse
   risk -- a known exploit beats an unaudited release. Record the decision in
   `scripts/dependency-age-exceptions.json` with the advisory ID:

   ```json
   {
     "some-package@2.0.1": "fixes GHSA-xxxx-yyyy-zzzz (critical), 2026-09-05"
   }
   ```

   The exception is a statement about one moment, so the check reports entries
   that have aged out and should be deleted. Never add one to silence the
   check for convenience; if there is no advisory ID, there is no exception.

5. **Update carefully.**

   One concern per commit, so a regression is bisectable:

   ```bash
   pnpm update --latest <package>      # or edit the manifest and pnpm install
   ```

   - Keep versions **exact**. This project pins them; a range hands the
     decision to whatever resolved last, and the age check cannot judge it.
   - Run the `check-licenses` skill if any `package.json` changed -- a new
     version can change its licence.
   - Run the `run-tests-and-linters` skill. A dependency update that passes
     nothing is not an update.
   - A user-visible consequence goes in CHANGES.md; a toolchain bump does not.

6. **Verify the result.**

   ```bash
   pnpm audit --prod
   node scripts/check-dependency-age.mjs
   ```

   Both must pass. Report what changed, what was deliberately left behind and
   why, and any advisory that remains open with the reason it cannot be closed
   yet.

## Do not

- Do not run `pnpm audit --fix` or `npm audit fix`. They resolve to whatever
  is newest, which is the version the 14-day rule exists to refuse.
- Do not update a major version as part of a release. It is its own change,
  with its own testing.
- Do not treat a clean `pnpm audit` as proof of anything beyond "no advisory
  has been published". Most of what the age rule protects against has no
  advisory yet.
