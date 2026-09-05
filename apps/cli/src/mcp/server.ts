import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TempDir } from '@ailoud/core';
import type { CliContext } from '../wiring.js';
import { Confirmations } from './confirm.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';
import { registerReadTools } from './toolsRead.js';
import { registerWriteTools } from './toolsWrite.js';
import { registerDeleteTools } from './toolsDelete.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';

export interface AiloudMcpServer {
  readonly server: McpServer;
  /** Removes the run's scratch directory, if one was ever created. */
  close(): Promise<void>;
}

export function buildMcpServer(context: CliContext, version: string): AiloudMcpServer {
  const server = new McpServer(
    { name: 'ailoud', version },
    {
      // The single most valuable text in this surface: it is what stops an
      // agent reading four transcripts to answer a question one search would
      // have answered.
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  // Created on first use, so a run that only lists things creates nothing, and
  // removed when the server stops. Transcripts handed to an agent are scratch:
  // the library in the database is the copy that outlives the process.
  let dir: TempDir | null = null;
  const runDir = async (): Promise<string> => {
    dir ??= await context.fs.tempDir();
    return dir.path;
  };

  const confirmations = new Confirmations(context.clock);

  registerReadTools(server, context, { runDir });
  registerWriteTools(server, context, { runDir });
  registerDeleteTools(server, context, confirmations);
  registerResources(server, context);
  registerPrompts(server);

  return {
    server,
    close: async () => {
      await dir?.remove();
      dir = null;
    },
  };
}
