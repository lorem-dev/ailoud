/**
 * The API key for a hosted language model, or undefined when there is none.
 *
 * Read from the environment, never from the config file: a config file gets
 * pasted into issues and committed by accident. LAUD_LLM_API_KEY comes first
 * so a laud-specific key overrides a shared vendor one.
 *
 * An empty value counts as absent. An exported-but-blank variable is the
 * classic half-configured shell, and treating it as a key would make `doctor`
 * report "key set" while every request comes back 401 -- sending the user
 * looking for the problem anywhere but where it is.
 */
export function apiKeyFrom(
  env: NodeJS.ProcessEnv,
  vendorVariable: 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY',
): string | undefined {
  for (const name of ['LAUD_LLM_API_KEY', vendorVariable]) {
    const value = env[name];
    if (value !== undefined && value.trim() !== '') return value;
  }
  return undefined;
}
