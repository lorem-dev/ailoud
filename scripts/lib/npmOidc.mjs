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

/**
 * npm's escaping: a scope's slash becomes %2f, everything else is literal.
 *
 * `replaceAll`, though a package name holds at most one slash: `replace` with a
 * string argument substitutes only the first match, so the single-slash case
 * was right by accident rather than by what the code said.
 */
export function escapePackageName(name) {
  return name.replaceAll('/', '%2f');
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

  let idResponse;
  try {
    idResponse = await fetch(idUrl, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`,
      },
    });
  } catch (error) {
    // The contract above says null, not a throw: a caller that can fall back
    // on an ambient `npm login` should get the chance, and a DNS or TLS
    // failure is exactly the transient case that fallback is for.
    log(`npm-oidc: could not reach GitHub for an id token: ${error.message}`);
    return null;
  }
  if (!idResponse.ok) {
    log(`npm-oidc: GitHub refused the id token (${idResponse.status})`);
    return null;
  }
  const { value: idToken } = await idResponse.json();
  if (typeof idToken !== 'string' || idToken === '') {
    log('npm-oidc: GitHub returned no id token');
    return null;
  }

  // The claims, not the token. npm binds a trusted publisher to a workflow
  // file, so a rejection usually means the identity is right and the workflow
  // is not the one configured -- which is invisible unless the claims are
  // printed. They are public metadata; the token they came in is not.
  log(`npm-oidc: identity ${describeClaims(idToken)}`);

  const exchange = `${REGISTRY}/-/npm/v1/oidc/token/exchange/package/${escapePackageName(name)}`;
  let response;
  try {
    response = await fetch(exchange, {
      method: 'POST',
      headers: { authorization: `Bearer ${idToken}`, accept: 'application/json' },
    });
  } catch (error) {
    log(`npm-oidc: could not reach the registry to exchange: ${error.message}`);
    return null;
  }
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
 * The claims npm matches a trusted publisher against, as one line.
 *
 * `workflow_ref` is the workflow the run entered through; `job_workflow_ref`
 * is the reusable workflow the job itself is defined in. They differ exactly
 * when one workflow calls another, which is the case this exists to explain.
 */
function describeClaims(idToken) {
  try {
    const [, payload] = idToken.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return [
      `sub=${claims.sub}`,
      `workflow_ref=${claims.workflow_ref}`,
      `job_workflow_ref=${claims.job_workflow_ref}`,
    ].join(' ');
  } catch {
    return '(claims unreadable)';
  }
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
