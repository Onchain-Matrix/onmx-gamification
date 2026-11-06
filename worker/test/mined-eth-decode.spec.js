import { describe, it, expect } from "vitest";
import example from "./fixtures/mined-purchases.js";
import { classifyPurchaseTime } from "../src/claims/policy.js";
import {
  decodeSeedPurchaseLog,
  deriveUsdFromPurchase,
  SEED_PURCHASE_TOPIC0,
  SALE_PROXIES,
  padTopicAddress,
  ERC20_TRANSFER_TOPIC0,
} from "../src/claims/decode.js";

function synthesizeLogsFromExample(ex) {
  const sp = ex.seedPurchaseCompleted;
  const proxy = SALE_PROXIES[ex.chainId];
  const paymentToken = sp.paymentToken.toLowerCase();
  const paymentAmount = BigInt(sp.paymentAmount_raw);
  const onmx = BigInt(sp.onmxAllocation_raw);
  const ts = BigInt(sp.purchaseTimestamp);
  const chain = BigInt(sp.sourceChainId);
  const data =
    "0x" +
    paymentToken.replace(/^0x/, "").padStart(64, "0") +
    paymentAmount.toString(16).padStart(64, "0") +
    onmx.toString(16).padStart(64, "0") +
    ts.toString(16).padStart(64, "0") +
    chain.toString(16).padStart(64, "0");

  const transfer = ex.usdtTransfer;
  const transferData = "0x" + BigInt(transfer.amount_raw).toString(16).padStart(64, "0");

  return [
    {
      address: paymentToken,
      topics: [ERC20_TRANSFER_TOPIC0, padTopicAddress(transfer.from), padTopicAddress(transfer.to)],
      data: transferData,
      logIndex: transfer.logIndex,
    },
    {
      address: proxy,
      topics: [SEED_PURCHASE_TOPIC0, sp.purchaseId, padTopicAddress(sp.purchaser)],
      data,
      logIndex: sp.logIndex,
    },
  ];
}

describe("mined ETH+BNB SeedPurchaseCompleted fixtures (isolated)", () => {
  it("ETH primary: USD=1 from paymentAmount not calldata ONMX", () => {
    const ex = example.eth_primary;
    const logs = synthesizeLogsFromExample(ex);
    const decoded = decodeSeedPurchaseLog(logs[1], 1);
    expect(decoded.paymentAmount).toBe(1000000n);
    expect(BigInt(ex.call.tokenAmount_raw)).not.toBe(decoded.paymentAmount);
    const usd = deriveUsdFromPurchase({ decoded, logs, chainId: 1, requireTransferMatch: true });
    expect(usd.purchaseUsd).toBe(1);
  });

  it("ETH second: USD=5003.35", () => {
    const ex = example.eth_second;
    const logs = synthesizeLogsFromExample(ex);
    const decoded = decodeSeedPurchaseLog(logs[1], 1);
    const usd = deriveUsdFromPurchase({ decoded, logs, chainId: 1, requireTransferMatch: true });
    expect(usd.purchaseUsd).toBe(5003.35);
  });

  it("BNB primary: USD=10000 from 18dec paymentAmount; prelaunch UNASSIGNED", () => {
    const ex = example.bnb_primary;
    const logs = synthesizeLogsFromExample(ex);
    const decoded = decodeSeedPurchaseLog(logs[1], 56);
    expect(decoded.purchaser.toLowerCase()).toBe(ex.from.toLowerCase());
    expect(decoded.paymentAmount).toBe(10000000000000000000000n);
    expect(BigInt(ex.call.tokenAmount_raw)).toBe(BigInt(ex.seedPurchaseCompleted.onmxAllocation_raw));
    expect(BigInt(ex.call.tokenAmount_raw)).not.toBe(decoded.paymentAmount);
    const usd = deriveUsdFromPurchase({ decoded, logs, chainId: 56, requireTransferMatch: true });
    expect(usd.ok).toBe(true);
    expect(usd.purchaseUsd).toBe(10000);
    // blockTimestamp Nov 5 2026 EST = prelaunch
    const ms = ex.blockTimestamp_ms || decoded.purchaseTimestamp * 1000;
    const c = classifyPurchaseTime(ms);
    expect(c.status).toBe("unassigned");
    expect(c.queueReason).toBe("unassigned_prelaunch");
  });
});
