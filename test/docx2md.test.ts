/**
 * The docx2md MCP server with the Hagglyai middleware, in process: quotes signed with a local test key,
 * a fake facilitator (no chain), the real docx2md.py. Free MCP methods stay free; a premium tool call
 * pays the agreement's amount into the split once and is reported; a failed conversion is not charged.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHagglyPartner, InMemoryOutbox, InMemoryQuoteStore, REPLAY_HEADER } from "@hagglyai/premium-x402";
import { premiumFetch } from "@hagglyai/premium-x402/client";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme as ClientScheme } from "@x402/evm/exact/client";
import { ExactEvmScheme as ServerScheme } from "@x402/evm/exact/server";
import { describe, expect, it } from "vitest";
import { createMcpApp, toolCallBody } from "../examples/docx2md/app";
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

const MCP_URL = "https://docx.example.test/mcp";
const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

/** A minimal .docx: one heading (outline level 0) and a paragraph with a bold run. */
function makeDocx(): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "docx-test-"));
  const out = join(dir, "t.docx");
  const xml =
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>Invoice</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t xml:space="preserve">Total: </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>£12</w:t></w:r></w:p>' +
    "</w:body></w:document>";
  execFileSync("python3", [
    "-I",
    "-c",
    "import sys, zipfile; zipfile.ZipFile(sys.argv[1], 'w').writestr('word/document.xml', sys.argv[2])",
    out,
    xml,
  ]);
  const bytes = new Uint8Array(readFileSync(out));
  rmSync(dir, { recursive: true });
  return bytes;
}
const docx = makeDocx();

function setup() {
  const settled: Settlement[] = [];
  const store = new InMemoryQuoteStore();
  const outbox = new InMemoryOutbox();
  const partner = createHagglyPartner({
    providerId: PROVIDER_ID,
    issuer: ISSUER,
    keys: { k1: premiumKey.publicKey },
    agreement,
    store,
    outbox,
  });
  const server = partner.attach(
    new x402ResourceServer(fakeFacilitator(settled) as never).register(NETWORK, new ServerScheme()),
  );
  const app = createMcpApp({
    partner,
    server,
    network: NETWORK,
    ordinaryPrice: "$0.01",
    providerWallet: PROVIDER_WALLET,
  });
  const sent: Request[] = [];
  const appFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    sent.push(req.clone());
    return app.fetch(req);
  }) as typeof fetch;
  const rpc = (body: string, headers: Record<string, string> = {}) =>
    appFetch(MCP_URL, { method: "POST", headers: { ...HEADERS, ...headers }, body });
  const pay = (q: string) =>
    premiumFetch({ quote: q, schemes: [["eip155:*", new ClientScheme(buyer)]], fetch: appFetch });
  return { settled, store, outbox, rpc, pay, sent };
}

describe("docx2md MCP server with Hagglyai Premium", () => {
  it("keeps initialize, notifications and tools/list free", async () => {
    const { rpc, settled } = setup();
    const init = await rpc(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
    );
    expect(init.status).toBe(200);
    expect(((await init.json()) as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-06-18");
    expect((await rpc(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).status).toBe(202);
    const list = (await (await rpc(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }))).json()) as {
      result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] };
    };
    expect(list.result.tools.map((t) => t.name)).toEqual(["docx_to_markdown"]);
    expect(list.result.tools[0]?.annotations.readOnlyHint).toBe(false);
    expect(settled).toEqual([]);
  });

  it("asks an ordinary tool call for the ordinary price, paid to the provider", async () => {
    const res = await setup().rpc(toolCallBody(docx));
    expect(res.status).toBe(402);
    const required = decodePaymentRequiredHeader(res.headers.get("payment-required") as string);
    expect(required.accepts.map((a) => [a.payTo.toLowerCase(), a.amount])).toEqual([[PROVIDER_WALLET, "10000"]]);
  });

  it("pays a premium tool call into the split once, answers it and reports the delivery", async () => {
    const { rpc, pay, settled, outbox, sent } = setup();
    const body = toolCallBody(docx, "call-1");
    const q = await quote({ method: "POST", url: MCP_URL, body });

    const unpaid = await rpc(body, { "haggly-premium": q });
    expect(unpaid.status).toBe(402);
    const required = decodePaymentRequiredHeader(unpaid.headers.get("payment-required") as string);
    expect(required.accepts.map((a) => [a.payTo.toLowerCase(), a.amount])).toEqual([[SPLIT, "2000"]]);

    const res = await pay(q)(MCP_URL, { method: "POST", headers: HEADERS, body });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id: string; result: { content: { text: string }[] } };
    expect(json.id).toBe("call-1");
    expect(json.result.content[0]?.text).toBe("# Invoice\n\nTotal: **£12**\n");
    expect(settled).toEqual([{ payTo: SPLIT, amount: "2000", network: NETWORK }]);
    expect(outbox.events).toMatchObject([
      { type: "delivered", providerId: PROVIDER_ID, amountAtomic: "2000", splitAddress: SPLIT },
    ]);

    // The same paid request again (a lost response) is replayed, not charged.
    const payment = sent.map((r) => r.headers.get("payment-signature")).find(Boolean) as string;
    const again = await rpc(body, { "haggly-premium": q, "payment-signature": payment });
    expect(again.status).toBe(200);
    expect(again.headers.get(REPLAY_HEADER)).toBe("1");
    expect(((await again.json()) as { id: string }).id).toBe("call-1");
    expect(settled).toHaveLength(1);
    expect(outbox.events).toHaveLength(1);
  });

  it("refuses a quote for another call before any payment", async () => {
    const { rpc, settled } = setup();
    const q = await quote({ method: "POST", url: MCP_URL, body: toolCallBody(docx, "a") });
    const res = await rpc(toolCallBody(docx, "b"), { "haggly-premium": q });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "quote_mismatch", problems: ["request"] });
    expect(settled).toEqual([]);
  });

  it("does not charge for a document it cannot convert", async () => {
    const { pay, settled, outbox } = setup();
    const body = toolCallBody(new TextEncoder().encode("not a zip file"));
    const q = await quote({ method: "POST", url: MCP_URL, body });
    const res = await pay(q)(MCP_URL, { method: "POST", headers: HEADERS, body });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ result: { isError: true } });
    expect(settled).toEqual([]);
    expect(outbox.events).toEqual([]);
  });
});
