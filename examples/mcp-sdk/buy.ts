/**
 * One real premium call to any MCP server's paid tool: Hagglyai's go-live test for a new provider
 * (docs/provider-guide.md, step 7). Builds the exact JSON-RPC `tools/call` body, asks Hagglyai
 * Premium for a quote for those bytes, then pays with the official x402 client (premiumFetch).
 *
 * This spends real USDC on Base. Use a wallet holding only what you mean to spend.
 *
 *   BUYER_KEY_FILE=~/.config/haggly/buyer.key MCP_URL=https://mcp.example.com/mcp \
 *   TOOL=word_count ARGS='{"text":"hello world"}' MAX_AMOUNT_ATOMIC=500000 npx tsx examples/mcp-sdk/buy.ts
 *
 * Environment: BUYER_KEY_FILE (or BUYER_KEY), MCP_URL, TOOL, ARGS (JSON, default {});
 * optionally PREMIUM_URL (default production), MAX_AMOUNT_ATOMIC (default 10000 = $0.01).
 */
import { readFile } from "node:fs/promises";
import { requestDigest } from "@hagglyai/premium-protocol";
import { premiumFetch } from "@hagglyai/premium-x402/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const { MCP_URL, TOOL, BUYER_KEY_FILE } = process.env;
const rawKey = (process.env.BUYER_KEY ?? (BUYER_KEY_FILE ? await readFile(BUYER_KEY_FILE, "utf8") : "")).trim();
const key = rawKey && !rawKey.startsWith("0x") ? `0x${rawKey}` : rawKey;
if (!/^0x[0-9a-fA-F]{64}$/.test(key) || !MCP_URL || !TOOL) {
  throw new Error("set BUYER_KEY_FILE (or BUYER_KEY: 0x plus 64 hex), MCP_URL and TOOL");
}
const premiumUrl = process.env.PREMIUM_URL ?? "https://premium.hagglyai.com";
const buyer = privateKeyToAccount(key as `0x${string}`);
const body = JSON.stringify({
  jsonrpc: "2.0",
  id: crypto.randomUUID(),
  method: "tools/call",
  params: { name: TOOL, arguments: JSON.parse(process.env.ARGS ?? "{}") },
});

// 1. A quote for these exact bytes.
const res = await fetch(new URL("/v1/quote", premiumUrl), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    method: "POST",
    url: MCP_URL,
    requestDigest: await requestDigest({ method: "POST", url: MCP_URL, body }),
    payer: buyer.address,
    network: "eip155:8453",
    asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    maxAmountAtomic: process.env.MAX_AMOUNT_ATOMIC ?? "10000",
    idempotencyId: crypto.randomUUID(),
  }),
});
if (!res.ok) throw new Error(`no quote: ${res.status} ${await res.text()}`);
const { quote, terms } = (await res.json()) as { quote: string; terms: { amountAtomic: string; payTo: string } };
console.log(`quoted ${terms.amountAtomic} base units, payable to ${terms.payTo}`);

// 2. The paid call. premiumFetch signs only if the provider's 402 matches the quote.
const pay = premiumFetch({ quote, schemes: [["eip155:*", new ExactEvmScheme(buyer)]] });
const answer = await pay(MCP_URL, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body,
});
console.log(answer.status, `settled: ${Boolean(answer.headers.get("payment-response"))}`);
console.log(await answer.text());
