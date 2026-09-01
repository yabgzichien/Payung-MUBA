/**
 * MCP adapter over Payung's own tool registry.
 *
 * Deliberately NOT built on @thetanuts-finance/mcp. That server exposes a
 * generic surface that permits WRITING options — the one thing a Payung user
 * must never do by accident. Payung's registry has already applied the
 * buyable-puts-only, correct-underlying, and dollar-collateral filters, so this
 * adapter inherits those guarantees for free.
 *
 * Because ToolDef already carries JSON Schema, this is an adapter, not a
 * reimplementation.
 */
import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, toolByName, type ToolContext } from '../src/tools';

const ctx: ToolContext = { candidates: new Map(), spec: null, signerAddress: null };

const server = new Server(
  { name: 'payung', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters,
    annotations: { readOnlyHint: t.readOnly },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = toolByName(req.params.name);
  if (!tool) {
    return { isError: true, content: [{ type: 'text', text: `No such tool: ${req.params.name}` }] };
  }
  const result = await tool.run(req.params.arguments ?? {}, ctx);
  return result.ok
    ? { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] }
    : { isError: true, content: [{ type: 'text', text: result.error }] };
});

await server.connect(new StdioServerTransport());
