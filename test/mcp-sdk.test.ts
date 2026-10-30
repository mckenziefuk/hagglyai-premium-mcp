/**
 * The onboarding guide's MCP pattern, on Hono and on Express, with the official MCP SDK: quotes signed as
 * the premium service signs them, a fake facilitator (no chain). Free methods stay free; a quoted paid
 * call pays the split once and is reported; a failed tool call is not charged; a quote for another
 * call is refused before any payment.
 */
import type { AddressInfo } from "node:net";
import { createHagglyPartner, InMemoryOutbox, InMemoryQuoteStore } from "@hagglyai/premium-x402";
import { premiumFetch } from "@hagglyai/premium-x402/client";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme as ClientScheme } from "@x402/evm/exact/client";
import { ExactEvmScheme as ServerScheme } from "@x402/evm/exact/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createPaidMcpExpressApp } from "../examples/mcp-sdk/express";
import { createPaidMcpApp } from "../examples/mcp-sdk/hono";
import {
  agreement,
  buyer,
  fakeFacilitator,
  ISSUER,
  NETWORK,
  PROVIDER_ID,
  PROVIDER_WALLET,
  premiumKey,
  quote,
  type Settlement,
  SPLIT,
} from "./helpers";

const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const call = (id: string, text: string) =>
  JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "word_count", arguments: { text } } });

const servers: { close(): void }[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

type Options = Parameters<typeof createPaidMcpApp>[0];
const frameworks: [string, (o: Options) => Promise<{ url: string; fetch: typeof fetch }>][] = [
  [
    "Hono",
    async (o) => {
      const app = createPaidMcpApp(o);
      const url = "https://mcp.example.test/mcp";
      return {
        url,
        fetch: (async (i: RequestInfo | URL, init?: RequestInit) => app.fetch(new Request(i, init))) as typeof fetch,
      };
    },
  ],
  [
    "Express",
    async (o) => {
      const app = createPaidMcpExpressApp(o);
      const listening = app.listen(0);
      servers.push(listening);
      await new Promise((r) => listening.once("listening", r));
      const { port } = listening.address() as AddressInfo;
      return { url: `http://127.0.0.1:${port}/mcp`, fetch };
    },
  ],
];

describe.each(frameworks)("paid MCP server on %s", (_, start) => {
  async function setup() {
    const settled: Settlement[] = [];
    const outbox = new InMemoryOutbox();
    const partner = createHagglyPartner({
      providerId: PROVIDER_ID,
      issuer: ISSUER,
      keys: { k1: premiumKey.publicKey },
      agreement,
      store: new InMemoryQuoteStore(),
      outbox,
    });
    const server = partner.attach(
      new x402ResourceServer(fakeFacilitator(settled) as never).register(NETWORK, new ServerScheme()),
    );
    const { url, fetch: send } = await start({
      partner,
      server,
      network: NETWORK,
      price: "$0.01",
      payTo: PROVIDER_WALLET,
    });
    const rpc = (body: string, headers: Record<string, string> = {}) =>
      send(url, { method: "POST", headers: { ...HEADERS, ...headers }, body });
    const pay = (q: string, body: string) =>
      premiumFetch({ quote: q, schemes: [["eip155:*", new ClientScheme(buyer)]], fetch: send })(url, {
        method: "POST",
        headers: HEADERS,
        body,
      });
    return { url, rpc, pay, settled, outbox };
  }

  it("keeps tools/list free", async () => {
    const { rpc, settled } = await setup();
    const res = await rpc(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ result: { tools: [{ name: "word_count" }] } });
    expect(settled).toEqual([]);
  });

  it("asks a call without a quote for the provider's ordinary price", async () => {
    const res = await (await setup()).rpc(call("a", "one two"));
    expect(res.status).toBe(402);
    const required = decodePaymentRequiredHeader(res.headers.get("payment-required") as string);
    expect(required.accepts.map((a) => [a.payTo.toLowerCase(), a.amount])).toEqual([[PROVIDER_WALLET, "10000"]]);
  });

  it("pays a quoted call into the split once, answers it and reports it", async () => {
    const { url, pay, settled, outbox } = await setup();
    const body = call("paid-1", "one two three");
    const res = await pay(await quote({ method: "POST", url, body }), body);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "paid-1", result: { content: [{ type: "text", text: "3" }] } });
    expect(settled).toEqual([{ payTo: SPLIT, amount: "2000", network: NETWORK }]);
    // Express records the delivery when the response has finished, just after the client has it.
    await vi.waitFor(() =>
      expect(outbox.events).toMatchObject([{ type: "delivered", amountAtomic: "2000", splitAddress: SPLIT }]),
    );
  });

  it("does not charge a call whose tool fails", async () => {
    const { url, pay, settled, outbox } = await setup();
    const body = call("paid-2", "   ");
    const res = await pay(await quote({ method: "POST", url, body }), body);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ result: { isError: true } });
    expect(settled).toEqual([]);
    expect(outbox.events).toEqual([]);
  });

  it("refuses a quote for another call before any payment", async () => {
    const { url, rpc, settled } = await setup();
    const q = await quote({ method: "POST", url, body: call("x", "a b") });
    const res = await rpc(call("y", "a b"), { "haggly-premium": q });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "quote_mismatch" });
    expect(settled).toEqual([]);
  });
});
