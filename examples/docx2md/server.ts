/**
 * Runs the docx2md MCP server (app.ts) on Node 22.5 or later, with state in a SQLite file through
 * node:sqlite. Needs python3 on the PATH for docx2md.py.
 *
 *   npx tsx examples/docx2md/server.ts
 *
 * Environment: HAGGLY_PROVIDER_ID, HAGGLY_AGREEMENT (JSON), HAGGLY_JWKS (JSON), HAGGLY_EVENTS_TOKEN,
 * PROVIDER_WALLET, FACILITATOR_URL, BASE_RPC_URL; optionally PREMIUM_URL (default https://premium.hagglyai.com),
 * ORDINARY_PRICE (default $0.01), JOBS_SECONDS (default 60), STATE_FILE and PORT (default 8787).
 */
import { DatabaseSync } from "node:sqlite";
import { Agreement } from "@hagglyai/premium-protocol";
import { createHagglyPartner, eip3009AuthorizationUsed, importPinnedKeys } from "@hagglyai/premium-x402";
import { diagnose } from "@hagglyai/premium-x402/diagnose";
import { deliverOutbox, PROVIDER_SCHEMA, SqlOutbox, SqlQuoteStore, sqliteExecutor } from "@hagglyai/premium-x402/sql";
import { serve } from "@hono/node-server";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { createMcpApp, MCP_PATH, toolCallBody } from "./app.js";

const NETWORK = "eip155:8453";
const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};
const premiumUrl = process.env.PREMIUM_URL ?? "https://premium.hagglyai.com";

const db = new DatabaseSync(process.env.STATE_FILE ?? "mcp-provider-state.db");
db.exec(PROVIDER_SCHEMA);
const sql = sqliteExecutor(db);
const store = new SqlQuoteStore(sql);
const outbox = new SqlOutbox(sql);
const keys = await importPinnedKeys(JSON.parse(env("HAGGLY_JWKS")));

const partner = createHagglyPartner({
  providerId: env("HAGGLY_PROVIDER_ID"),
  issuer: premiumUrl,
  keys,
  agreement: Agreement.parse(JSON.parse(env("HAGGLY_AGREEMENT"))),
  store,
  outbox,
});
const server = partner.attach(
  new x402ResourceServer(new HTTPFacilitatorClient({ url: env("FACILITATOR_URL") })).register(
    NETWORK,
    new ExactEvmScheme(),
  ),
);
const app = createMcpApp({
  partner,
  server,
  network: NETWORK,
  ordinaryPrice: process.env.ORDINARY_PRICE ?? "$0.01",
  providerWallet: env("PROVIDER_WALLET"),
});

// The order probe is a paid tool call: only those go through the middleware.
const probe = {
  app: (r: Request) => app.fetch(r),
  probeUrl: `http://localhost${MCP_PATH}`,
  probeMethod: "POST",
  probeBody: toolCallBody(new Uint8Array([0]), "diagnose"),
};
for (const c of (await diagnose({ keys, store, outbox, premiumUrl, ...probe })).checks) {
  console.log(`diagnose: ${c.status} ${c.name}: ${c.detail}`);
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`MCP server on http://localhost:${port}${MCP_PATH} (premium quotes from ${premiumUrl})`);

// Outside the response path: settle uncertain payments, report deliveries to Hagglyai.
const chain = createPublicClient({ chain: base, transport: http(env("BASE_RPC_URL")) });
const jobs = async () => {
  try {
    for (const jti of await store.uncertain()) {
      console.log(`reconcile ${jti}: ${await partner.reconcile(jti, eip3009AuthorizationUsed(chain))}`);
    }
    const sent = await deliverOutbox({ sql, premiumUrl, eventsToken: env("HAGGLY_EVENTS_TOKEN") });
    if (sent.delivered || sent.retrying || sent.failed) console.log("outbox:", JSON.stringify(sent));
  } catch (err) {
    console.error("background jobs:", err);
  }
};
setInterval(jobs, Number(process.env.JOBS_SECONDS ?? 60) * 1000);
