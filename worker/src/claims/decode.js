/**
 * Decode SeedPurchaseCompleted logs from official dApp-published ABI (m0).
 * Evidence: frontend interface from onchainmatrix.com bundle — not explorer-verified Solidity.
 */
import { keccak_256 } from "../auth/keccak.js";

export const SEED_PURCHASE_TOPIC0 =
  "0x9cf645f0930779acb1ac7de1633160834232e3e873b6552bd3978c562aa019a0";

export const SALE_PROXIES = Object.freeze({
  56: "0x933c05b86dbd2234a23810f5d447b4537a907b08",
  1: "0x08c701207be45e8884fa48572a0517efba796cc0",
});

/** Stable USDT addresses used by official dApp UI. */
export const USDT_BY_CHAIN = Object.freeze({
  56: { address: "0x55d398326f99059ff775485246999027b3197955", decimals: 18 },
  1: { address: "0xdac17f958d2ee523a2206206994597c13d831ec7", decimals: 6 },
});

export const CONFIRMATIONS = Object.freeze({ 56: 15, 1: 12 });

/** Official treasury addresses (GitBook) — USDT may route purchaser→treasury or proxy→treasury. */
export const TREASURY_BY_CHAIN = Object.freeze({
  56: "0xc7de7f659316d19602005020b944089dac58423a",
  1: "0x9b8ca8189569e70165dfc1478975c9fb26d6f560",
});

function padTopicAddress(addr) {
  return "0x" + "0".repeat(24) + addr.replace(/^0x/, "").toLowerCase();
}

export function wordToAddress(word) {
  return ("0x" + word.slice(-40)).toLowerCase();
}

export function wordToBigInt(word) {
  return BigInt("0x" + word);
}

/** Parse a SeedPurchaseCompleted log. Returns null if not matching. */
export function decodeSeedPurchaseLog(log, expectedChainId) {
  const topics = log.topics || [];
  if (!topics.length || String(topics[0]).toLowerCase() !== SEED_PURCHASE_TOPIC0) return null;
  const proxy = SALE_PROXIES[expectedChainId];
  if (!proxy || String(log.address || "").toLowerCase() !== proxy) return null;
  if (topics.length < 3) return null;
  const purchaseId = topics[1];
  const purchaser = wordToAddress(topics[2]);
  const data = String(log.data || "").replace(/^0x/, "");
  if (data.length < 64 * 5) return null;
  const words = [];
  for (let i = 0; i < 5; i++) words.push(data.slice(i * 64, (i + 1) * 64));
  const paymentToken = wordToAddress(words[0]);
  const paymentAmount = wordToBigInt(words[1]);
  const onmxAllocation = wordToBigInt(words[2]);
  const purchaseTimestamp = Number(wordToBigInt(words[3]));
  const sourceChainId = Number(wordToBigInt(words[4]));
  return {
    purchaseId,
    purchaser,
    paymentToken,
    paymentAmount,
    onmxAllocation,
    purchaseTimestamp,
    sourceChainId,
    logIndex: Number(log.logIndex ?? log.log_index ?? 0),
  };
}

export function paymentAmountToUsd(paymentToken, paymentAmount, chainId) {
  const usdt = USDT_BY_CHAIN[chainId];
  if (!usdt) return { ok: false, error: "unsupported_chain_usdt" };
  if (paymentToken !== usdt.address) {
    // Native / unknown — fail closed until USD valuation source known
    if (paymentToken === "0x0000000000000000000000000000000000000000") {
      return { ok: false, error: "native_payment_usd_unknown" };
    }
    return { ok: false, error: "payment_token_not_allowlisted" };
  }
  const raw = Number(paymentAmount) / 10 ** usdt.decimals;
  if (!Number.isFinite(raw) || raw <= 0) return { ok: false, error: "invalid_payment_amount" };
  // USDT ≈ USD 1:1 for scoring purposes (provisional)
  return { ok: true, purchaseUsd: Math.round(raw * 1e6) / 1e6, decimals: usdt.decimals };
}

export function assertTopic0() {
  const sig = "SeedPurchaseCompleted(bytes32,address,address,uint256,uint256,uint256,uint256)";
  const h = keccak_256(new TextEncoder().encode(sig));
  const hex = "0x" + [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === SEED_PURCHASE_TOPIC0;
}

export { padTopicAddress };

/** ERC20 Transfer(address,address,uint256) */
export const ERC20_TRANSFER_TOPIC0 =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export function decodeErc20Transfer(log, expectedToken) {
  const topics = log.topics || [];
  if (!topics.length || String(topics[0]).toLowerCase() !== ERC20_TRANSFER_TOPIC0) return null;
  if (expectedToken && String(log.address || "").toLowerCase() !== expectedToken.toLowerCase()) return null;
  if (topics.length < 3) return null;
  const from = wordToAddress(topics[1]);
  const to = wordToAddress(topics[2]);
  const data = String(log.data || "").replace(/^0x/, "");
  if (data.length < 64) return null;
  const amount = wordToBigInt(data.slice(0, 64));
  return { from, to, amount, token: String(log.address).toLowerCase() };
}

/**
 * Prefer event.paymentAmount for USD. Optionally require matching USDT Transfer amount.
 * NEVER use purchaseTokens calldata tokenAmount as USD (that is ONMX qty).
 */
export function deriveUsdFromPurchase({ decoded, logs, chainId, requireTransferMatch = true }) {
  // USD ONLY from event.paymentAmount + allowlisted token decimals — never calldata tokenAmount (ONMX).
  const usd = paymentAmountToUsd(decoded.paymentToken, decoded.paymentAmount, chainId);
  if (!usd.ok) return usd;
  if (!requireTransferMatch || !logs) return { ...usd, transferMatched: null };
  const usdt = USDT_BY_CHAIN[chainId];
  const treasury = TREASURY_BY_CHAIN[chainId];
  const proxy = SALE_PROXIES[chainId];
  let matched = false;
  for (const log of logs) {
    const tr = decodeErc20Transfer(log, usdt.address);
    if (!tr) continue;
    if (tr.amount !== decoded.paymentAmount) continue;
    // ETH pattern: purchaser → treasury; BNB observed: sale proxy → treasury
    const fromOk = tr.from === decoded.purchaser || tr.from === proxy;
    const toOk = !treasury || tr.to === treasury;
    if (fromOk && toOk) {
      matched = true;
      break;
    }
  }
  if (!matched) return { ok: false, error: "usdt_transfer_mismatch" };
  return { ...usd, transferMatched: true };
}
