/** What the tool modules need from the server that is not the CliContext. */
export interface McpDeps {
  /**
   * The directory this server run writes transcript and report files into,
   * created on first use and removed when the server stops.
   *
   * A function rather than a path so nothing is created by a run that only
   * ever lists things.
   */
  runDir(): Promise<string>;
}
