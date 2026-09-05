// Exchange a CI OIDC identity for a short-lived npm token.
//
// This is what `npm publish` does for itself and exposes to nothing else:
// trusted publishing is defined for publishing, so `npm deprecate` and
// `npm dist-tag` in the same job have nothing to authenticate with. Doing the
// two calls here means retiring a release needs no stored credential either.
//
// Read out of npm's own implementation (lib/utils/oidc.js in npm 11):
//
//   GET  $ACTIONS_ID_TOKEN_REQUEST_URL&audience=npm:registry.npmjs.org
//        Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN   -> { value }
//   POST /-/npm/v1/oidc/token/exchange/package/<escaped name>
//        Authorization: Bearer <value>                           -> { token }
//
// The token is minted per package and is never printed or written anywhere but
// the temporary npmrc the caller hands to npm.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REGISTRY = 'https://registry.npmjs.org';

/** npm's escaping: a scope's slash becomes %2f, everything else is literal. */
export function escapePackageName(name) {
  return name.replace('/', '%2f');
}

/** True when this process is a GitHub Actions job with `id-token: write`. */
export function canExchange() {
  return Boolean(
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  );
}

/**
 * A short-lived npm token for one package, or null with the reason logged.
 *
 * Returns null rather than throwing: a caller that cannot get a token should
 * be able to fall back on an ambient `npm login`, which is how this runs from
 * a laptop.
 */
export async function tokenForPackage(name, log = console.error) {
  if (!canExchange()) {
    log('npm-oidc: not a GitHub Actions job with id-token: write');
    return null;
  }
  const idUrl = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
  idUrl.searchParams.set('audience', `npm:${new URL(REGISTRY).hostname}`);

  const idResponse = await fetch(idUrl, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`,
    },
  });
  if (!idResponse.ok) {
    log(`npm-oidc: GitHub refused the id token (${idResponse.status})`);
    return null;
  }
  const { value: idToken } = await idResponse.json();
  if (typeof idToken !== 'string' || idToken === '') {
    log('npm-oidc: GitHub returned no id token');
    return null;
  }

  const exchange = `${REGISTRY}/-/npm/v1/oidc/token/exchange/package/${escapePackageName(name)}`;
  const response = await fetch(exchange, {
    method: 'POST',
    headers: { authorization: `Bearer ${idToken}`, accept: 'application/json' },
  });
  if (!response.ok) {
    // The body carries npm's reason -- usually that no trusted publisher is
    // attached to this package -- and holds no secret.
    const body = await response.text();
    log(`npm-oidc: ${name} exchange failed (${response.status}): ${body.slice(0, 200)}`);
    return null;
  }
  const { token } = await response.json();
  if (typeof token !== 'string' || token === '') {
    log(`npm-oidc: ${name} exchange returned no token`);
    return null;
  }
  return token;
}

/**
 * Runs `body(env)` with a temporary npmrc holding the token, then removes it.
 *
 * A file rather than an argument or an env var: a token on a command line is
 * visible to every process on the machine, and npm's env form of this key
 * needs a variable name containing slashes and a colon.
 */
export function withNpmToken(token, body) {
  const dir = mkdtempSync(join(tmpdir(), 'ailoud-npmrc-'));
  const file = join(dir, '.npmrc');
  try {
    writeFileSync(file, `//registry.npmjs.org/:_authToken=${token}\n`, { mode: 0o600 });
    return body({ ...process.env, NPM_CONFIG_USERCONFIG: file });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
