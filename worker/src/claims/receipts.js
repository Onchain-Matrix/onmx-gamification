/**
 * Seed purchase receipt verification against official dApp-published ABI interface.
 * Distinguishes: decoder implemented vs RPC config vs production grants (always off until X + owner policy).
 */
import { POLICY } from "./policy.js";
import {
  decodeSeedPurchaseLog,
  deriveUsdFromPurchase,
  SALE_PROXIES,
  USDT_BY_CHAIN,
  CONFIRMATIONS,
  SEED_PURCHASE_TOPIC0,
  assertTopic0,
} from "./decode.js";
import { getReceipt, getBlockNumber, pickRpc } from "./rpc.js";

export const PUBLIC_RPC_DEFAULTS = Object.freeze({
  bnb: Object.freeze(["https://bsc-dataseed.binance.org/", "https://bsc.publicnode.com"]),
  eth: Object.freeze(["https://ethereum.publicnode.com", "https://cloudflare-eth.com"]),
});

export function receiptVerificationStatus(env) {
  const rpcConfigured = Boolean(env.BNB_RPC_URL || env.ETH_RPC_URL);
  const decoderReady = assertTopic0();
  return {
    available: decoderReady,
    reason: decoderReady
      ? "decoder_ready_eth_and_bnb_mined_crosschecked_grants_off"
      : "decoder_topic_mismatch",
    detail:
      "SeedPurchaseCompleted decoder uses official dApp m0 ABI. ETH+BNB mined receipts cross-checked (USD from event.paymentAmount + USDT decimals/transfer; calldata tokenAmount=ONMX only). Grants OFF until X OAuth + owner prelaunch policy.",
    ethMinedCrosscheck: true,
    bnbMinedCrosscheck: true,
    contracts: POLICY.contracts,
    saleProxies: SALE_PROXIES,
    usdtAllowlist: USDT_BY_CHAIN,
    topic0: SEED_PURCHASE_TOPIC0,
    confirmations: CONFIRMATIONS,
    rpcConfigured,
    publicRpcDefaultsUsedWhenUnset: true,
    eip1271: "optional_eth_call_when_rpc_reachable",
    acceptsFakeFixtures: false,
    productionGrantsEnabled: false,
    verificationReadiness: decoderReady ? "implemented" : "broken",
    grantsReadiness: "disabled",
  };
}

/**
 * Verify a mined purchase receipt.
 * Requires: successful tx, SeedPurchaseCompleted from allowlisted proxy, USDT payment,
 * confirmations, purchaser matches authenticated wallet for that chain.
 */
export async function verifySeedPurchaseReceipt(env, input, { fetchImpl = fetch, walletAddress = null } = {}) {
  const status = receiptVerificationStatus(env);
  if (!status.available) {
    return { ok: false, error: "receipt_decoder_unavailable", status: 503, verification: status };
  }

  const chainId = Number(input.chainId);
  if (![1, 56].includes(chainId)) return { ok: false, error: "unsupported_chain", status: 400, verification: status };
  const txHash = String(input.txHash || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(txHash)) return { ok: false, error: "invalid_tx_hash", status: 400, verification: status };

  const rpcUrl = pickRpc(env, chainId);
  if (!rpcUrl) return { ok: false, error: "rpc_unavailable", status: 503, verification: status };

  let receipt;
  try {
    receipt = await getReceipt(rpcUrl, txHash, fetchImpl);
  } catch (e) {
    return { ok: false, error: String(e.message || e), status: 502, verification: status };
  }
  if (!receipt) return { ok: false, error: "receipt_not_found", status: 404, verification: status };
  if (String(receipt.status) !== "0x1" && Number(receipt.status) !== 1) {
    return { ok: false, error: "tx_failed", status: 400, verification: status };
  }

  const blockNumber = parseInt(receipt.blockNumber, 16);
  let latest;
  try {
    latest = await getBlockNumber(rpcUrl, fetchImpl);
  } catch (e) {
    return { ok: false, error: String(e.message || e), status: 502, verification: status };
  }
  const need = CONFIRMATIONS[chainId];
  if (latest - blockNumber < need) {
    return {
      ok: false,
      error: "insufficient_confirmations",
      status: 409,
      confirmations: latest - blockNumber,
      required: need,
      verification: status,
    };
  }

  const logs = receipt.logs || [];
  let decoded = null;
  let logIndex = 0;
  for (let i = 0; i < logs.length; i++) {
    const d = decodeSeedPurchaseLog(logs[i], chainId);
    if (d) {
      decoded = d;
      logIndex = Number(logs[i].logIndex ?? i);
      break;
    }
  }
  if (!decoded) {
    return { ok: false, error: "seed_purchase_event_not_found", status: 400, verification: status };
  }
  if (decoded.sourceChainId && Number(decoded.sourceChainId) !== chainId) {
    // soft check — some deployments may set source differently; require match when present
    return { ok: false, error: "source_chain_mismatch", status: 400, verification: status };
  }

  // USD from event.paymentAmount only (USDT decimals) — NEVER calldata tokenAmount (ONMX qty)
  const usd = deriveUsdFromPurchase({
    decoded,
    logs,
    chainId,
    requireTransferMatch: env.REQUIRE_USDT_TRANSFER_MATCH !== "0",
  });
  if (!usd.ok) return { ok: false, error: usd.error, status: 400, verification: status };

  // Purchaser must match linked wallet for this chain (identity bridge)
  if (walletAddress) {
    const want = String(walletAddress).toLowerCase();
    if (decoded.purchaser !== want) {
      return { ok: false, error: "purchaser_wallet_mismatch", status: 403, verification: status };
    }
  }

  const purchaseAtMs = decoded.purchaseTimestamp > 1e12
    ? decoded.purchaseTimestamp
    : decoded.purchaseTimestamp * 1000;

  return {
    ok: true,
    chainId,
    txHash,
    logIndex,
    purchaseUsd: usd.purchaseUsd,
    purchaseAtMs,
    purchaser: decoded.purchaser,
    paymentToken: decoded.paymentToken,
    purchaseId: decoded.purchaseId,
    receiptStatus: "verified_dapp_abi",
    verification: status,
  };
}

/**
 * Optional EIP-1271 isValidSignature eth_call when RPC is reachable.
 */
export async function verifyEip1271({ rpcUrl, contractAddress, messageHash, signature, fetchImpl = fetch }) {
  if (!rpcUrl) return { ok: false, error: "eip1271_rpc_unavailable" };
  const addr = String(contractAddress || "").toLowerCase().replace(/^0x/, "");
  if (addr.length !== 40) return { ok: false, error: "eip1271_bad_address" };
  const hash = String(messageHash || "").replace(/^0x/, "");
  const sig = String(signature || "").replace(/^0x/, "");
  if (hash.length !== 64) return { ok: false, error: "eip1271_bad_hash" };
  const sigLen = (sig.length / 2).toString(16).padStart(64, "0");
  const sigOffset = (32).toString(16).padStart(64, "0");
  const selector = "1626ba7e";
  const paddedSig = sig + "0".repeat((64 - (sig.length % 64)) % 64);
  const data = "0x" + selector + hash + sigOffset + sigLen + paddedSig;
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: "0x" + addr, data }, "latest"],
    }),
  });
  if (!res.ok) return { ok: false, error: "eip1271_rpc_http" };
  const j = await res.json();
  const out = String(j.result || "").toLowerCase();
  if (out.startsWith("0x1626ba7e")) return { ok: true };
  return { ok: false, error: "eip1271_invalid" };
}
