import type { Command } from 'commander';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CliContext } from '../wiring.js';
import { buildMcpServer } from '../mcp/server.js';
import { registerMcpInstall } from './mcpInstall.js';

export function registerMcp(program: Command, context: CliContext): void {
  const mcp = program
    .command('mcp')
    .description('Run ailoud as an MCP server, so an agent can use the library')
    .addHelpText(
      'after',
      [
        '',
        'Speaks MCP over stdio. Configure your agent to run this command:',
        '',
        '  { "mcpServers": { "ailoud": { "command": "ailoud", "args": ["mcp"] } } }',
        '',
        'The library it serves is the same one the other commands use, so anything',
        'imported or transcribed here is visible there and the other way round.',
      ].join('\n'),
    )
    .action(async () => {
      // No ui.frame, no decoration, nothing on stdout: stdout IS the protocol
      // channel. A single stray line of human-facing text would corrupt the
      // JSON-RPC stream and the client would drop the connection. Every other
      // command in this codebase writes through context.ui; this one must not.
      const { server, close } = buildMcpServer(context, program.version() ?? '0.0.0');
      const transport = new StdioServerTransport();

      const shutdown = async (): Promise<void> => {
        await close();
        await server.close().catch(() => undefined);
      };
      // The client closing the pipe is the normal way this ends. Without these
      // the scratch directory would survive every session.
      process.on('SIGINT', () => void shutdown().then(() => process.exit(0)));
      process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));

      await server.connect(transport);
      // Resolves when the transport closes, which keeps the process alive for
      // the length of the session without a polling loop.
      await new Promise<void>((resolve) => {
        transport.onclose = () => resolve();
      });
      await shutdown();
    });

  registerMcpInstall(mcp, context);
}
