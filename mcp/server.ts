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
  try {
    const result = await tool.run(req.params.arguments ?? {}, ctx);
    if (!result.ok) {
      return { isError: true, content: [{ type: 'text', text: result.error }] };
    }
    // numbers is the grounding allowlist this tool call is allowed to cite —
    // included so a host model enforcing its own grounding guard has what it
    // needs; this adapter has no host-side prose to check itself.
    return {
      content: [{ type: 'text', text: JSON.stringify({ data: result.data, numbers: result.numbers }, null, 2) }],
    };
  } catch (e: any) {
    return { isError: true, content: [{ type: 'text', text: e?.message || String(e) }] };
  }
});

await server.connect(new StdioServerTransport());
