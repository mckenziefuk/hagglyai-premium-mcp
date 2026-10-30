/**
 * A buyer for the docx2md MCP server: for each call, builds the exact JSON-RPC `tools/call` body,
 * asks Hagglyai Premium for a quote for those bytes, then pays with the official x402 client
 * (premiumFetch). The payment goes into the provider's split.
 *
 * This spends real USDC on Base. Use a wallet holding only what you mean to spend.
 *
 *   BUYER_KEY=0x… MCP_URL=https://docx.example.com/mcp DOCX=report.docx npx tsx examples/docx2md/buy.ts
 *
 * Environment: BUYER_KEY (or BUYER_KEY_FILE, a file holding it), MCP_URL, DOCX (a .docx path);
 * optionally PREMIUM_URL (default https://premium.hagglyai.com), MAX_AMOUNT_ATOMIC (budget per call in USDC base units,
 * default 10000 = $0.01), CALLS (default 1).
 */
import { readFile } from "node:fs/promises";
import { requestDigest } from "@hagglyai/premium-protocol";
import { premiumFetch } from "@hagglyai/premium-x402/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { toolCallBody } from "./app.js";

const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const { MCP_URL, DOCX, BUYER_KEY_FILE } = process.env;
const rawKey = (process.env.BUYER_KEY ?? (BUYER_KEY_FILE ? await readFile(BUYER_KEY_FILE, "utf8") : "")).trim();
const BUYER_KEY = rawKey && !rawKey.startsWith("0x") ? `0x${rawKey}` : rawKey;
if (!BUYER_KEY || !MCP_URL || !DOCX) throw new Error("set BUYER_KEY (or BUYER_KEY_FILE), MCP_URL and DOCX");
if (!/^0x[0-9a-fA-F]{64}$/.test(BUYER_KEY)) throw new Error("the buyer key is not 0x plus 64 hex characters");
const premiumUrl = process.env.PREMIUM_URL ?? "https://premium.hagglyai.com";
const budget = process.env.MAX_AMOUNT_ATOMIC ?? "10000";
const calls = Number(process.env.CALLS ?? 1);
const buyer = privateKeyToAccount(BUYER_KEY as `0x${string}`);
const docx = new Uint8Array(await readFile(DOCX));
const mcpHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };

for (let i = 1; i <= calls; i++) {
  // 1. The exact request: its bytes are what the quote covers, so build them once and send them as is.
  const body = toolCallBody(docx);
  const res = await fetch(new URL("/v1/quote", premiumUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      method: "POST",
      url: MCP_URL,
      requestDigest: await requestDigest({ method: "POST", url: MCP_URL, body }),
      payer: buyer.address,
      network: "eip155:8453",
      asset: USDC_BASE,
      maxAmountAtomic: budget,
      idempotencyId: crypto.randomUUID(),
    }),
  });
  if (!res.ok) throw new Error(`call ${i}: no quote: ${res.status} ${await res.text()}`);
  const { quote, terms, commission } = (await res.json()) as {
    quote: string;
    terms: { amountAtomic: string; payTo: string };
    commission: { disclosure: string };
  };
  console.log(`call ${i}: quoted ${terms.amountAtomic} base units to ${terms.payTo}. ${commission.disclosure}`);

  // 2. The paid MCP call. premiumFetch signs only if the 402 matches the quote.
  const pay = premiumFetch({ quote, schemes: [["eip155:*", new ExactEvmScheme(buyer)]] });
  const answer = await pay(MCP_URL, { method: "POST", headers: mcpHeaders, body });
  const settled = answer.headers.get("payment-response");
  const json = (await answer.json().catch(() => null)) as {
    result?: { isError?: boolean; content?: { text: string }[] };
  } | null;
  if (answer.status !== 200 || json?.result?.isError) {
    console.log(`call ${i}: ${answer.status}`, JSON.stringify(json));
    continue;
  }
  const markdown = json?.result?.content?.[0]?.text ?? "";
  console.log(`call ${i}: 200, ${markdown.length} characters of Markdown, settled: ${Boolean(settled)}`);
  if (calls === 1) console.log(markdown);
}
