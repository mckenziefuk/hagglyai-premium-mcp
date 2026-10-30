/**
 * Test set-up shared by the examples' tests: an agreement, quotes signed as Hagglyai's premium service
 * signs them (with a throwaway key made here), and a fake facilitator that records settlements. No
 * chain is touched and no money moves.
 */
import { Agreement, agreementShares, requestDigest, signQuote } from "@hagglyai/premium-protocol";
import { x402Facilitator } from "@x402/core/facilitator";
import { registerExactEvmScheme } from "@x402/evm/exact/facilitator";
import { privateKeyToAccount } from "viem/accounts";

export const NETWORK = "eip155:8453";
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const PROVIDER_WALLET = "0x1111111111111111111111111111111111111111";
export const HAGGLY_WALLET = "0x2222222222222222222222222222222222222222";
export const SPLIT = "0x3333333333333333333333333333333333333333";
export const ISSUER = "https://premium.hagglyai.com";
export const PROVIDER_ID = "example-mcp";
/** Hardhat's well-known public test key: signs payments in tests only. Never use it for real funds. */
export const buyer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

export const agreement = Agreement.parse({
  id: "example-v1",
  version: 1,
  providerId: PROVIDER_ID,
  network: NETWORK,
  asset: USDC,
  buyerAmountAtomic: "2000",
  affiliateBps: 2000,
  splitAddress: SPLIT,
  providerWallet: PROVIDER_WALLET,
  affiliateWallet: HAGGLY_WALLET,
});

/** A throwaway signing key standing in for Hagglyai's (the real one never leaves Hagglyai). */
export const premiumKey = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
  "sign",
  "verify",
])) as CryptoKeyPair;

/** A quote as Hagglyai's premium service signs it, for one exact request. */
export async function quote(o: { url: string; method?: string; body?: string; id?: string }) {
  const method = o.method ?? "POST";
  return signQuote(
    {
      providerId: PROVIDER_ID,
      endpointId: `${method} ${new URL(o.url).pathname}`,
      agreementId: agreement.id,
      agreementVersion: agreement.version,
      method,
      requestDigest: await requestDigest({ method, url: o.url, body: o.body }),
      payer: buyer.address,
      network: NETWORK,
      asset: agreement.asset,
      scheme: "exact",
      amountAtomic: agreement.buyerAmountAtomic,
      splitAddress: agreement.splitAddress,
      recipients: agreementShares(agreement).map((s) => ({ address: s.recipient, bps: s.bps })),
      idempotencyId: o.id ?? crypto.randomUUID(),
    },
    { key: premiumKey.privateKey, kid: "k1", issuer: ISSUER, audience: PROVIDER_ID },
  );
}

export interface Settlement {
  payTo: string;
  amount: string;
  network: string;
}

/** A facilitator that accepts any well-formed exact-EVM payment and records what it would settle. */
export function fakeFacilitator(log: Settlement[]) {
  const real = new x402Facilitator();
  registerExactEvmScheme(real, {
    signer: { getAddresses: () => ["0x4444444444444444444444444444444444444444"] } as never,
    networks: [NETWORK],
  });
  const from = (p: { payload: unknown }) => (p.payload as { authorization: { from: string } }).authorization.from;
  return {
    getSupported: async () => real.getSupported(),
    verify: async (p: { payload: unknown }) => ({ isValid: true, payer: from(p) }),
    settle: async (p: { payload: unknown }, r: { payTo: string; amount: string; network: string }) => {
      log.push({ payTo: r.payTo.toLowerCase(), amount: r.amount, network: r.network });
      return {
        success: true,
        transaction: `0x${String(log.length).padStart(64, "0")}`,
        network: r.network,
        payer: from(p),
      };
    },
  };
}
