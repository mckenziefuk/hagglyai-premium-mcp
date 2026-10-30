/**
 * A paid MCP server on Hono (Cloudflare Workers, Node, Bun, Deno) with Hagglyai Premium in front of its
 * paid tools: the pattern in docs/provider-guide.md.
 *
 * MCP sends every message to one URL (POST /mcp), so payment is decided from the JSON-RPC body: a
 * `tools/call` of a paid tool goes through hagglyPremium and then the x402 middleware; everything else
 * goes straight to the MCP server, free.
 */
import type { HagglyPartner } from "@hagglyai/premium-x402";
import { hagglyPremium } from "@hagglyai/premium-x402/hono";
import type { x402ResourceServer } from "@x402/core/server";
import { paymentMiddleware } from "@x402/hono";
import { Hono } from "hono";
import { every } from "hono/combine";
import { handleMcp, isPaidCall } from "./mcp";

export function createPaidMcpApp(o: {
  partner: HagglyPartner;
  server: x402ResourceServer;
  network: `${string}:${string}`;
  /** Your ordinary x402 price and wallet, for callers without a Hagglyai quote. */
  price: string;
  payTo: string;
}) {
  const routes = {
    "POST /mcp": {
      accepts: { scheme: "exact", network: o.network, payTo: o.payTo, price: o.price },
      description: "Paid MCP tool call",
      mimeType: "application/json",
    },
  };
  // 1. Hagglyai's premium check, then 2. the official x402 middleware. The order matters.
  const paid = every(hagglyPremium(o.partner), paymentMiddleware(o.partner.routes(routes), o.server));

  const app = new Hono();
  app.post(
    "/mcp",
    async (c, next) => {
      const message = await c.req.raw
        .clone()
        .json()
        .catch(() => null);
      return isPaidCall(message) ? paid(c, next) : next();
    },
    (c) => handleMcp(c.req.raw),
  );
  return app;
}
