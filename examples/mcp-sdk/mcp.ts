/**
 * The MCP part, shared by the Hono and Express versions: your server built with the official MCP SDK,
 * which paid tools it has, and one function that answers an MCP request.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

/** The tools that cost money. Everything else on the server (initialize, tools/list, …) is free. */
export const PAID_TOOLS = ["word_count"];

/** Whether a JSON-RPC message is a call of a paid tool. */
export function isPaidCall(message: unknown): boolean {
  const m = message as { method?: unknown; params?: { name?: unknown } } | null;
  return m?.method === "tools/call" && PAID_TOOLS.includes(String(m.params?.name));
}

/** Your MCP server, exactly as you would write it without payments. */
function buildServer() {
  const server = new McpServer({ name: "example-paid-mcp", version: "1.0.0" });
  server.registerTool(
    "word_count",
    {
      title: "Word count",
      description: "Counts the words in a text. Paid per call (x402, USDC on Base).",
      inputSchema: { text: z.string() },
    },
    async ({ text }) => {
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;
      if (words === 0) return { isError: true, content: [{ type: "text", text: "the text is empty" }] };
      return { content: [{ type: "text", text: String(words) }] };
    },
  );
  return server;
}

/**
 * Answers one MCP request (stateless: a fresh server and transport each time, JSON responses rather
 * than a stream). A tool error is HTTP 200 in MCP; it is answered 422 instead, so a failed paid call
 * is never charged (x402 settles only responses below 400).
 */
export async function handleMcp(request: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await buildServer().connect(transport);
  const res = await transport.handleRequest(request);
  if (res.status !== 200 || !res.headers.get("content-type")?.includes("application/json")) return res;
  const body = await res.text();
  const failed = (JSON.parse(body) as { result?: { isError?: boolean } }).result?.isError === true;
  return new Response(body, { status: failed ? 422 : 200, headers: res.headers });
}
