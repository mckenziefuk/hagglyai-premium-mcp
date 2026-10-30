/**
 * A small MCP server (Streamable HTTP, stateless, JSON responses) with one paid tool,
 * `docx_to_markdown`, which runs docx2md.py, behind Hagglyai Premium: a premium call pays the
 * agreement's price into the split; a call without a quote pays the ordinary price.
 *
 * MCP sends every message to one URL (`POST /mcp`), so the payment middleware cannot be mounted on a
 * route alone. Only a `tools/call` of the paid tool goes through hagglyPremium and the x402
 * middleware; initialize, ping, notifications and tools/list stay free. A quote covers the exact
 * JSON-RPC body (including its `id`), so the buyer builds the body before asking for the quote.
 *
 * A conversion that fails answers HTTP 422: the x402 middleware settles only below 400, so a failed
 * call is never charged. (MCP would normally answer 200 with `isError`.)
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { HagglyPartner } from "@hagglyai/premium-x402";
import { hagglyPremium } from "@hagglyai/premium-x402/hono";
import type { x402ResourceServer } from "@x402/core/server";
import { paymentMiddleware } from "@x402/hono";
import { Hono } from "hono";
import { every } from "hono/combine";

export const MCP_PATH = "/mcp";
export const PAID_TOOL = "docx_to_markdown";
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
/** Largest .docx accepted, decoded. */
export const MAX_DOCX_BYTES = 5 * 1024 * 1024;

const TOOL = {
  name: PAID_TOOL,
  title: "Word document to Markdown",
  description:
    "Converts a .docx file (base64) to Markdown: headings, emphasis, links, lists, tables, footnotes. " +
    "Paid per call with x402 (USDC on Base); Hagglyai Premium quotes are accepted.",
  inputSchema: {
    type: "object",
    properties: { docx_base64: { type: "string", description: "The .docx file, base64-encoded" } },
    required: ["docx_base64"],
    additionalProperties: false,
  },
  // A paid call is not read-only, even though it changes nothing on the server (roadmap: paid
  // execution must never inherit a read-only classification).
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

const SCRIPT = fileURLToPath(new URL("./docx2md.py", import.meta.url));
const run = promisify(execFile);

export class ConversionError extends Error {}

/** Runs docx2md.py on the bytes and returns its Markdown. */
export async function docxToMarkdown(docx: Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "docx2md-"));
  try {
    const input = join(dir, "input.docx");
    await writeFile(input, docx);
    const { stdout, stderr } = await run("python3", ["-I", SCRIPT, input, "-o", "-"], {
      timeout: 20_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    // docx2md.py reports a bad file on stderr and still exits 0.
    if (stderr.includes("error:")) throw new ConversionError("not a valid .docx file");
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const isPaidCall = (m: unknown) => {
  const msg = m as JsonRpcRequest | null;
  return msg?.method === "tools/call" && (msg.params as { name?: unknown } | undefined)?.name === PAID_TOOL;
};

export interface McpAppOptions {
  partner: HagglyPartner;
  server: x402ResourceServer;
  network: `${string}:${string}`;
  /** The ordinary (non-premium) price and wallet, e.g. "$0.01". */
  ordinaryPrice: string;
  providerWallet: string;
  convert?: (docx: Uint8Array) => Promise<string>;
}

export function createMcpApp(o: McpAppOptions) {
  const convert = o.convert ?? docxToMarkdown;
  const routes = {
    [`POST ${MCP_PATH}`]: {
      accepts: { scheme: "exact", network: o.network, payTo: o.providerWallet, price: o.ordinaryPrice },
      description: `MCP tool ${PAID_TOOL}`,
      mimeType: "application/json",
    },
  };
  // The premium check first, then the official x402 middleware (docs/guide.md, step 5).
  const paid = every(hagglyPremium(o.partner), paymentMiddleware(o.partner.routes(routes), o.server));

  const app = new Hono();
  app.get(MCP_PATH, (c) => c.body(null, 405, { allow: "POST" })); // no server-to-client stream
  app.delete(MCP_PATH, (c) => c.body(null, 405, { allow: "POST" })); // stateless: no sessions

  app.post(
    MCP_PATH,
    async (c, next) => {
      const msg = await c.req.raw
        .clone()
        .json()
        .catch(() => null);
      return isPaidCall(msg) ? paid(c, next) : next();
    },
    async (c) => {
      const msg = (await c.req.json().catch(() => null)) as JsonRpcRequest | null;
      const reply = (result: unknown) => c.json({ jsonrpc: "2.0", id: msg?.id ?? null, result });
      const fail = (code: number, message: string, status: 200 | 400 = 200) =>
        c.json({ jsonrpc: "2.0", id: msg?.id ?? null, error: { code, message } }, status);

      if (!msg || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
        return fail(-32600, "invalid request", 400);
      }
      if (msg.id === undefined) return c.body(null, 202); // a notification

      switch (msg.method) {
        case "initialize": {
          const asked = String(msg.params?.protocolVersion ?? "");
          return reply({
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: {} },
            serverInfo: { name: "docx2md-x402", version: "0.1.0" },
            instructions: `${PAID_TOOL} is paid per call with x402 (HTTP 402 on POST ${MCP_PATH}).`,
          });
        }
        case "ping":
          return reply({});
        case "tools/list":
          return reply({ tools: [TOOL] });
        case "tools/call": {
          if (!isPaidCall(msg)) return fail(-32602, `unknown tool ${String(msg.params?.name)}`);
          const b64 = (msg.params?.arguments as { docx_base64?: unknown } | undefined)?.docx_base64;
          const toolError = (text: string) =>
            c.json({ jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text }] } }, 422);
          if (typeof b64 !== "string") return toolError("docx_base64 is required");
          const docx = Buffer.from(b64, "base64");
          if (docx.length === 0 || docx.length > MAX_DOCX_BYTES) {
            return toolError(`the .docx must be 1 byte to ${MAX_DOCX_BYTES} bytes`);
          }
          try {
            const markdown = await convert(new Uint8Array(docx));
            return reply({ content: [{ type: "text", text: markdown }] });
          } catch (err) {
            return toolError(err instanceof ConversionError ? err.message : "conversion failed");
          }
        }
        default:
          return fail(-32601, `method not found: ${msg.method}`);
      }
    },
  );
  return app;
}

/** The JSON-RPC body for one paid call. The buyer gets a quote for exactly these bytes. */
export function toolCallBody(docx: Uint8Array, id: string | number = crypto.randomUUID()): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: PAID_TOOL, arguments: { docx_base64: Buffer.from(docx).toString("base64") } },
  });
}
