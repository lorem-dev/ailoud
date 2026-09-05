---
name: dev-tag
description: >
  Cut a throwaway development tag (`v<version>-dev.<n>`) to publish a snapshot
  to npm under the `dev` dist-tag and exercise the release pipeline. Publishes
  no documentation and never moves `latest`.
---

# dev-tag

A development tag publishes a snapshot nobody will get by accident, so a real
install of real code can be tried before a release is promised.

## The three kinds of tag

| Tag            | Cut from   | npm dist-tag | Docs published |
| -------------- | ---------- | ------------ | -------------- |
| `v1.2.3-dev.1` | any branch | `dev`        | no             |
| `v1.2.3-rc.1`  | `develop`  | `next`       | no             |
| `v1.2.3`       | `main`     | `latest`     | yes            |

Only a final tag moves `latest` and publishes documentation. `npm install
ailoud` therefore never picks up a dev tag, and the site never describes a
version nobody can install.

Except once per package: npm sets `latest` on a FIRST publish whatever `--tag`
says, and `latest` cannot be removed afterwards, only moved. If a dev tag is
what introduces a package to the registry -- as v1.0.0-dev.1 was -- then
`latest` points at that snapshot until a final version is published.

## Cutting one

1. The working tree must be clean and the gate green:

   ```
   pnpm build && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:cov
   ```

2. Set the version across the manifests. `-dev.<n>` is a pre-release, so it
   sorts BELOW the release it precedes:

   ```
   node scripts/bump-version.mjs 1.2.3-dev.1
   ```

   `bump-version` promotes the CHANGES.md `## Development` section, which a dev
   tag does not want -- so for a dev tag, set the versions by hand and leave
   the changelog alone:

   ```
   node -e "for (const p of ['package.json','packages/core/package.json','packages/providers/package.json','apps/cli/package.json']) { const fs=require('fs'); const d=JSON.parse(fs.readFileSync(p,'utf8')); d.version='1.2.3-dev.1'; fs.writeFileSync(p, JSON.stringify(d,null,2)+'\n'); }"
   ```

3. Commit, tag and push. The publish workflow checks that every manifest
   agrees with the tag, so these cannot drift:

   ```
   git commit -am "chore: 1.2.3-dev.1"
   git tag -s v1.2.3-dev.1 -m "v1.2.3-dev.1"
   git push origin HEAD --tags
   ```

4. Try it from the registry, which is the whole point:

   ```
   npm install -g ailoud@dev
   ailoud --version
   ```

## What it does not do

- It does not publish documentation. `docs.yml` starts only on a final tag and
  refuses a pre-release twice over.
- It does not move `latest`.
- It is not a release candidate. An `-rc.` tag says "this is what the release
  will be"; a `-dev.` tag says "this is a snapshot to try".

## Cleaning up

A dev version cannot be unpublished after 72 hours and its number can never be
reused, so use a fresh `-dev.<n>` each time rather than retrying one.

Once the final release is out, retire every snapshot it supersedes in one step:

```
node scripts/retire-prereleases.mjs 1.2.3          # prints the plan
node scripts/retire-prereleases.mjs 1.2.3 --yes    # carries it out
```

It deprecates the versions rather than unpublishing them, drops the `dev`
dist-tag, and deletes the tags -- but only those whose commit is reachable from
`main`. The provenance of a published package names both the commit and the tag
it was built from: delete the tag and the name stops resolving, which costs
convenience; delete a tag holding the only reference to its commit and the
commit itself can be collected, which costs the attestation its subject. Tags
in the second case are reported and left alone.
