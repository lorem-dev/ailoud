#!/usr/bin/env node
// Establish that npm will accept us for EVERY package before publishing any.
//
// Usage: node scripts/preflight-npm-auth.mjs
//
// The publish loop goes library, library, CLI. Without this, a credential that
// works for two of the three publishes two of the three -- and a version
// number npm has seen can never be reused, so the release cannot simply be
// retried at the same version. Trusted publishing is configured per package on
// npmjs.com, one page at a time, which is exactly the sort of thing that is
// complete for two packages and not the third.
//
// A token in NPM_TOKEN covers whatever it was granted, and asking the registry
// to confirm that would mean a write; the bootstrap path is checked by using
// it. This exists for the OIDC path, where the answer is knowable up front.
import { PACKAGES, fail } from './lib/changelog.mjs';
import { canExchange, tokenForPackage } from './lib/npmOidc.mjs';

const SCOPE = 'preflight-npm-auth';

if (process.env.NPM_TOKEN !== undefined && process.env.NPM_TOKEN !== '') {
  console.log(`${SCOPE}: NPM_TOKEN is set; nothing to exchange.`);
  process.exit(0);
}

if (!canExchange()) {
  fail(SCOPE, 'no NPM_TOKEN and no OIDC identity -- npm would refuse every publish.');
}

const missing = [];
for (const pkg of PACKAGES) {
  const token = await tokenForPackage(pkg);
  console.log(`  ${pkg}: ${token === null ? 'NO CREDENTIAL' : 'ok'}`);
  if (token === null) missing.push(pkg);
}

if (missing.length > 0) {
  fail(
    SCOPE,
    `npm would refuse to publish ${missing.join(', ')}. Attach the trusted publisher on ` +
      'each package page (organization lorem-dev, repository ailoud, workflow publish.yml, ' +
      'environment empty). Nothing has been published, so no version number is spent.',
  );
}

console.log(`${SCOPE}: every package will accept this run.`);
