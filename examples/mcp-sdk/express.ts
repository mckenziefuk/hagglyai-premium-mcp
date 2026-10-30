/**
 * The same paid MCP server on Express (Node), for servers built with the MCP SDK on Express: the
 * pattern in docs/provider-guide.md. Only a `tools/call` of a paid tool goes through
 * hagglyPremium and the x402 middleware; everything else goes straight to the MCP server, free.
 */
import type { HagglyPartner } from "@hagglyai/premium-x402";
import { captureRawBody, hagglyPremium } from "@hagglyai/premium-x402/express";
import type { x402ResourceServer } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import express, { type Request as ExpressRequest } from "express";
import { handleMcp, isPaidCall } from "./mcp";

/** The Express request as a web Request, with the exact body bytes the quote covers. */
function toRequest(req: ExpressRequest & { rawBody?: Buffer }): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers.set(k, v);
    else if (Array.isArray(v)) for (const x of v) headers.append(k, x);
  }
  return new Request(`${req.protocol}://${req.get("host")}${req.originalUrl}`, {
    method: req.method,
    headers,
    body: req.rawBody ? new Uint8Array(req.rawBody) : undefined,
  });
}

export function createPaidMcpExpressApp(o: {
  partner: HagglyPartner;
  server: x402ResourceServer;
  network: `${string}:${string}`;
  /** Your ordinary x402 price and wallet, for callers without a Hagglyai quote. */
  price: string;
  payTo: string;
}) {
  const routes = {
    "POST /mcp": {
      accepts: { scheme: "exact" as const, network: o.network, payTo: o.payTo, price: o.price },
      description: "Paid MCP tool call",
      mimeType: "application/json",
    },
  };
  const app = express();
  app.use(express.json({ verify: captureRawBody })); // a quote covers the exact body bytes

  // 1. Hagglyai's premium check, then 2. the official x402 middleware. The order matters.
  const paid = express.Router();
  paid.use(hagglyPremium(o.partner), paymentMiddleware(o.partner.routes(routes), o.server));

  app.post(
    "/mcp",
    (req, res, next) => (isPaidCall(req.body) ? paid(req, res, next) : next()),
    async (req, res) => {
      const answer = await handleMcp(toRequest(req));
      res.status(answer.status);
      answer.headers.forEach((v, k) => {
        res.setHeader(k, v);
      });
      res.send(Buffer.from(await answer.arrayBuffer()));
    },
  );
  return app;
}
