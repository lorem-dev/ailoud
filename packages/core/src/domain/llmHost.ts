/**
 * Whether a language-model endpoint is one of the hosted APIs.
 *
 * By hostname, compared exactly. Two places used to ask this with a substring
 * -- `baseUrl.startsWith('https://api.openai.com')` and
 * `/api\.(openai|anthropic)\.com/.test(baseUrl)` -- and both answered yes for
 * `https://api.openai.com.example.net/v1`, where the interesting part of the
 * name is what follows. A local server, which is the case these checks exist
 * to spare, is any other host.
 */
const HOSTED_HOSTS: readonly string[] = ['api.openai.com', 'api.anthropic.com'];

export function isHostedLlm(baseUrl: string): boolean {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    // Not a URL at all. Reported elsewhere as a configuration error; treating
    // it as hosted here would demand an API key for a value that cannot
    // address anything.
    return false;
  }
  return HOSTED_HOSTS.includes(parsed.hostname.toLowerCase());
}

/**
 * `baseUrl` without trailing slashes, so a path can be appended to it.
 *
 * Written as a loop rather than `replace(/\/+$/, '')`: on a value ending in
 * many slashes that pattern backtracks, which is a denial of service when the
 * value comes from anywhere but us. There is no regex worth that here.
 */
export function withoutTrailingSlashes(baseUrl: string): string {
  let end = baseUrl.length;
  while (end > 0 && baseUrl[end - 1] === '/') end -= 1;
  return baseUrl.slice(0, end);
}
