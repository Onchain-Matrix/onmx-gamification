/**
 * Purchase receipt verification — FAIL CLOSED until verified seed ABI + RPC exist.
 * tx hash alone / transfer to treasury alone is NOT proof of eligible purchase.
 * Magna vesting != sale.
 */
import { POLICY } from "./policy.js";

export function receiptVerificationStatus(env) {
  return {
    available: false,
    reason: "seed_sale_abi_events_unavailable",
    detail:
      "Full verified seed sale ABI/events not found (BscScan/Sourcify blocked previously). Official GitBook lists proxies only. Crediting stays fail-closed until ABI + payer/beneficiary semantics + RPC confirmations are configured.",
    contracts: POLICY.contracts,
    rpcConfigured: Boolean(env.BNB_RPC_URL || env.ETH_RPC_URL),
    acceptsFakeFixtures: false,
  };
}

export async function verifySeedPurchaseReceipt(_env, _input) {
  return {
    ok: false,
    error: "receipt_verification_unavailable",
    status: 503,
    verification: receiptVerificationStatus(_env),
  };
}
