import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createWorker } from "../src/index.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { hashPersonalMessage, buildSiweMessage } from "../src/auth/siwe.js";
import { treasuryBuyPoints, classifyPurchaseTime, resolveAwardSeason, POLICY } from "../src/claims/policy.js";
import { applyMigrations } from "./apply-migrations.js";
import {
  SEED_PURCHASE_TOPIC0,
  ERC20_TRANSFER_TOPIC0,
  decodeSeedPurchaseLog,
  paymentAmountToUsd,
  SALE_PROXIES,
  assertTopic0,
  padTopicAddress,
} from "../src/claims/decode.js";
import { createPkcePair, startXOAuth, completeXCallback, xConfigStatus } from "../src/auth/x-oauth.js";

const ORIGIN = "https://onchain-matrix.github.io";

function privToAddress(priv) {
  const pub = secp256k1.getPublicKey(priv, false).slice(1);
  return "0x" + [...keccak_256(pub).slice(12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signMessage(message, priv) {
  const msgHash = await hashPersonalMessage(message);
  const sig65 = secp256k1.sign(msgHash, priv, { format: "recovered" });
  const recovery = sig65[0];
  const rs = sig65.slice(1);
  const v = recovery + 27;
  return "0x" + [...rs].map((b) => b.toString(16).padStart(2, "0")).join("") + v.toString(16).padStart(2, "0");
}

function sessionCookie(res) {
  const multi = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  if (multi && multi.length) return multi.find((c) => c.startsWith("onmx_session=")) || multi[0];
  const raw = res.headers.get("Set-Cookie");
  if (!raw) return null;
  const m = raw.match(/onmx_session=[^;]+/);
  return m ? m[0] : raw.split(",")[0];
}

function makeFakeReceipt({ chainId = 56, purchaser, paymentUsd = 1000, txHash, logIndex = 0 }) {
  const proxy = SALE_PROXIES[chainId];
  const usdt = chainId === 56
    ? "0x55d398326f99059ff775485246999027b3197955"
    : "0xdac17f958d2ee523a2206206994597c13d831ec7";
  const decimals = chainId === 56 ? 18 : 6;
  const amount = BigInt(Math.round(paymentUsd * 10 ** decimals));
  const ts = Math.floor(Date.parse("2026-11-20T15:00:00-05:00") / 1000);
  const data =
    "0x" +
    usdt.replace(/^0x/, "").padStart(64, "0") +
    amount.toString(16).padStart(64, "0") +
    (10n ** 18n).toString(16).padStart(64, "0") +
    BigInt(ts).toString(16).padStart(64, "0") +
    BigInt(chainId).toString(16).padStart(64, "0");
  const purchaseId = "0x" + "ab".repeat(32);
  const treasury = chainId === 56 ? "0xc7de7f659316d19602005020b944089dac58423a" : "0x9b8ca8189569e70165dfc1478975c9fb26d6f560";
  return {
    status: "0x1",
    blockNumber: "0x100",
    logs: [
      {
        address: usdt,
        topics: [ERC20_TRANSFER_TOPIC0, padTopicAddress(purchaser), padTopicAddress(treasury)],
        data: "0x" + amount.toString(16).padStart(64, "0"),
        logIndex: "0x0",
      },
      {
        address: proxy,
        topics: [SEED_PURCHASE_TOPIC0, purchaseId, padTopicAddress(purchaser)],
        data,
        logIndex: "0x" + Math.max(1, logIndex).toString(16),
      },
    ],
  };
}

function fakeRpcFetch(purchaser, opts = {}) {
  const receipt = makeFakeReceipt({
    chainId: opts.chainId || 56,
    purchaser,
    paymentUsd: opts.paymentUsd || 1000,
    txHash: opts.txHash,
    logIndex: opts.logIndex || 0,
  });
  return async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "eth_getTransactionReceipt") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: receipt }), { status: 200 });
    }
    if (body.method === "eth_blockNumber") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x120" }), { status: 200 }); // 32 conf > 15
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "unexpected " + body.method } }), { status: 200 });
  };
}

describe("policy + decoder", () => {
  it("exp-v1 + prelaunch + next season", () => {
    expect(treasuryBuyPoints(1000)).toBeCloseTo(158.03, 2);
    expect(classifyPurchaseTime(Date.parse("2026-11-01T12:00:00-05:00")).status).toBe("unassigned");
    const c = classifyPurchaseTime(Date.parse("2026-11-20T12:00:00-05:00"));
    expect(resolveAwardSeason({ classification: c, existingCurrentSeasonClaims: 1 }).awardSeason).toBe(2);
  });
  it("topic0 matches ABI event signature", () => {
    expect(assertTopic0()).toBe(true);
  });
  it("decodes SeedPurchaseCompleted and USDT USD", () => {
    const purchaser = "0x1111111111111111111111111111111111111111";
    const receipt = makeFakeReceipt({ chainId: 56, purchaser, paymentUsd: 1000 });
    const d = decodeSeedPurchaseLog(receipt.logs[1], 56);
    expect(d.purchaser).toBe(purchaser);
    const usd = paymentAmountToUsd(d.paymentToken, d.paymentAmount, 56);
    expect(usd.ok).toBe(true);
    expect(usd.purchaseUsd).toBe(1000);
  });
  it("rejects non-USDT payment", () => {
    const r = paymentAmountToUsd("0x0000000000000000000000000000000000000000", 1n, 56);
    expect(r.error).toBe("native_payment_usd_unknown");
  });
});

describe("API security + claims", () => {
  const priv = secp256k1.utils.randomSecretKey();
  const address = privToAddress(priv);

  // Worker with injectable verifier for ledger races + grants path
  let worker;
  let fakeX;

  beforeAll(async () => {
    await applyMigrations(env.DB);
    env.BNB_RPC_URL = "https://bsc-dataseed.binance.org/";
    env.ETH_RPC_URL = "https://ethereum.publicnode.com";
    env.X_CLIENT_ID = "test_client_id";
    env.X_CLIENT_SECRET = "test_client_secret";
    env.X_REDIRECT_URI = "https://onmx-gamification-claims.onmx.workers.dev/v1/auth/x/callback";

    fakeX = {
      authorize: "https://fake.x.test/authorize",
      token: "https://fake.x.test/token",
      me: "https://fake.x.test/me",
    };

    const xFetch = async (url, init = {}) => {
      const u = String(url);
      if (u.startsWith(fakeX.token)) {
        const body = init.body?.toString?.() || "";
        if (!body.includes("code_verifier=") || !body.includes("code=good")) {
          return new Response("bad", { status: 400 });
        }
        return new Response(JSON.stringify({ access_token: "atok", token_type: "bearer" }), { status: 200 });
      }
      if (u.startsWith(fakeX.me)) {
        const auth = init.headers?.Authorization || "";
        if (!auth.includes("atok")) return new Response("no", { status: 401 });
        return new Response(JSON.stringify({ data: { id: "999888777", username: "onmx_tester" } }), { status: 200 });
      }
      return new Response("nf", { status: 404 });
    };

    worker = createWorker({
      fetchImpl: async (url, init) => {
        const u = String(url);
        if (u.includes("fake.x.test")) return xFetch(url, init);
        // default: treat as RPC for receipt tests that set their own worker instance
        return fakeRpcFetch(address)(url, init);
      },
      xEndpoints: fakeX,
      allowClaimInsert: true,
      claimVerifier: async (e, input, opts) => {
        // Prefer real verifier with fake RPC
        const { verifySeedPurchaseReceipt } = await import("../src/claims/receipts.js");
        return verifySeedPurchaseReceipt(e, input, {
          fetchImpl: fakeRpcFetch(opts.walletAddress || address, {
            chainId: Number(input.chainId),
            paymentUsd: Number(input._testUsd || 1000),
            logIndex: Number(input.logIndex || 0),
          }),
          walletAddress: opts.walletAddress,
        });
      },
    });
  });

  async function fetchWorker(path, init = {}, w = worker) {
    const request = new Request("https://onmx-gamification-claims.onmx.workers.dev" + path, init);
    const ctx = createExecutionContext();
    const res = await w.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  async function loginWallet(w = worker) {
    const ch = await fetchWorker(
      "/v1/auth/wallet/challenge",
      {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json", Referer: ORIGIN + "/" },
        body: JSON.stringify({ address, chainId: 56 }),
      },
      w
    );
    const challenge = await ch.json();
    expect(ch.status).toBe(200);
    const signature = await signMessage(challenge.message, priv);
    const ver = await fetchWorker(
      "/v1/auth/wallet/verify",
      {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json", Referer: ORIGIN + "/" },
        body: JSON.stringify({ message: challenge.message, signature, address, chainId: 56 }),
      },
      w
    );
    const j = await ver.json();
    expect(ver.status).toBe(200);
    expect(j.accessToken).toBeTruthy();
    return j;
  }

  it("health + config distinguishes decoder vs grants", async () => {
    const c = await (await fetchWorker("/v1/config")).json();
    expect(c.receipts.verificationReadiness).toBe("implemented");
    expect(c.receipts.grantsReadiness).toBe("disabled");
    expect(c.receipts.productionGrantsEnabled).toBe(false);
    expect(c.readiness.xLoginEnabled).toBe(true); // secrets present in test env
    expect(c.readiness.preferredCrossSiteSession).toBe("bearer");
  });

  it("X OAuth start→callback→handoff→bearer (fake provider)", async () => {
    const start = await fetchWorker("/v1/auth/x/start", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", Referer: ORIGIN + "/" },
      body: JSON.stringify({ openerOrigin: ORIGIN }),
    });
    expect(start.status).toBe(200);
    const sj = await start.json();
    expect(sj.authorizeUrl).toContain("code_challenge");
    expect(sj.authorizeUrl).toContain("state=");
    const state = sj.state;

    // Bad state replay / wrong code
    const badCb = await fetchWorker(`/v1/auth/x/callback?code=good&state=nope`);
    expect(badCb.status).toBeGreaterThanOrEqual(400);

    const cb = await fetchWorker(`/v1/auth/x/callback?code=good&state=${state}`);
    expect(cb.status).toBe(200);
    const html = await cb.text();
    expect(html).toContain("postMessage");
    expect(html).toContain("handoffCode");
    const handoff = html.match(/"handoffCode":"([^"]+)"/)[1];

    // Replay state
    const replay = await fetchWorker(`/v1/auth/x/callback?code=good&state=${state}`);
    expect(replay.status).toBeGreaterThanOrEqual(400);

    const ex = await fetchWorker("/v1/auth/session/exchange", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", Referer: ORIGIN + "/" },
      body: JSON.stringify({ handoffCode: handoff }),
    });
    expect(ex.status).toBe(200);
    const ej = await ex.json();
    expect(ej.accessToken).toBeTruthy();
    expect(ej.sessionMode).toBe("bearer");

    // handoff one-use
    const ex2 = await fetchWorker("/v1/auth/session/exchange", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", Referer: ORIGIN + "/" },
      body: JSON.stringify({ handoffCode: handoff }),
    });
    expect(ex2.status).toBe(409);

    const me = await fetchWorker("/v1/me", { headers: { Authorization: "Bearer " + ej.accessToken } });
    expect(me.status).toBe(200);
    const mj = await me.json();
    expect(mj.x.xUserId).toBe("999888777");
    expect(mj.sessionVia).toBe("bearer");
  });

  it("X start fail-closed without secrets", async () => {
    const saved = { id: env.X_CLIENT_ID, secret: env.X_CLIENT_SECRET, redir: env.X_REDIRECT_URI };
    env.X_CLIENT_ID = "";
    env.X_CLIENT_SECRET = "";
    env.X_REDIRECT_URI = "";
    const w = createWorker({ xEndpoints: fakeX, allowClaimInsert: true });
    const res = await fetchWorker(
      "/v1/auth/x/start",
      {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json", Referer: ORIGIN + "/" },
        body: JSON.stringify({ openerOrigin: ORIGIN }),
      },
      w
    );
    expect(res.status).toBe(503);
    env.X_CLIENT_ID = saved.id;
    env.X_CLIENT_SECRET = saved.secret;
    env.X_REDIRECT_URI = saved.redir;
  });

  it("wallet bearer session + receipt decode path", async () => {
    const j = await loginWallet();
    const tx = "0x" + "11".repeat(32);
    const res = await fetchWorker("/v1/claims/receipt", {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        "Content-Type": "application/json",
        Referer: ORIGIN + "/",
        Authorization: "Bearer " + j.accessToken,
        "X-CSRF-Token": j.csrf,
      },
      body: JSON.stringify({ chainId: 56, txHash: tx, logIndex: 0 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.claim.pointsRaw).toBeCloseTo(158.03, 2);
    expect(body.claim.awardSeason).toBe(1);
    expect(body.claim.formulaVersion).toBe("exp-v1");

    // duplicate receipt
    const dup = await fetchWorker("/v1/claims/receipt", {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        "Content-Type": "application/json",
        Referer: ORIGIN + "/",
        Authorization: "Bearer " + j.accessToken,
        "X-CSRF-Token": j.csrf,
      },
      body: JSON.stringify({ chainId: 56, txHash: tx, logIndex: 0 }),
    });
    expect(dup.status).toBe(409);
  });

  it("concurrent first claims: only one season-1 award; other queues or rejects duplicate race", async () => {
    const j = await loginWallet();
    const headers = {
      Origin: ORIGIN,
      "Content-Type": "application/json",
      Referer: ORIGIN + "/",
      Authorization: "Bearer " + j.accessToken,
      "X-CSRF-Token": j.csrf,
    };
    const txA = "0x" + "aa".repeat(32);
    const txB = "0x" + "bb".repeat(32);
    const [r1, r2] = await Promise.all([
      fetchWorker("/v1/claims/receipt", { method: "POST", headers, body: JSON.stringify({ chainId: 56, txHash: txA }) }),
      fetchWorker("/v1/claims/receipt", { method: "POST", headers, body: JSON.stringify({ chainId: 56, txHash: txB }) }),
    ]);
    const j1 = await r1.json();
    const j2 = await r2.json();
    const ok = [j1, j2].filter((x) => x.ok);
    expect(ok.length).toBe(2);
    const seasons = ok.map((x) => x.claim.awardSeason).sort();
    expect(seasons).toEqual([1, 2]);
    const s1 = ok.find((x) => x.claim.awardSeason === 1);
    expect(s1.claim.pointsRaw).toBeLessThanOrEqual(250);

    // list and assert SUM season 1 <= 250
    const list = await (await fetchWorker("/v1/claims", { headers: { Authorization: "Bearer " + j.accessToken } })).json();
    const sum1 = list.claims.filter((c) => c.award_season === 1).reduce((a, c) => a + c.points_raw, 0);
    expect(sum1).toBeLessThanOrEqual(250);
  });

  it("prelaunch unassigned; client points ignored", async () => {
    // custom verifier returning prelaunch time
    const w = createWorker({
      allowClaimInsert: true,
      claimVerifier: async () => ({
        ok: true,
        chainId: 56,
        txHash: "0x" + "cc".repeat(32),
        logIndex: 0,
        purchaseUsd: 1000,
        purchaseAtMs: Date.parse("2026-11-01T12:00:00-05:00"),
        receiptStatus: "verified_dapp_abi",
      }),
    });
    const j = await loginWallet(w);
    const res = await fetchWorker(
      "/v1/claims/receipt",
      {
        method: "POST",
        headers: {
          Origin: ORIGIN,
          "Content-Type": "application/json",
          Referer: ORIGIN + "/",
          Authorization: "Bearer " + j.accessToken,
          "X-CSRF-Token": j.csrf,
        },
        body: JSON.stringify({ chainId: 56, txHash: "0x" + "cc".repeat(32), points: 99999 }),
      },
      w
    );
    const body = await res.json();
    expect(body.claim.awardSeason).toBeNull();
    expect(body.claim.pointsRaw).toBe(0);
    expect(body.claim.queueReason).toBe("unassigned_prelaunch");
  });

  it("production grants off: verify may preview but not insert without allowClaimInsert", async () => {
    const w = createWorker({
      allowClaimInsert: false,
      fetchImpl: fakeRpcFetch(address),
      claimVerifier: undefined, // real
    });
    // need real default verifier with fake rpc — recreate
    const w2 = createWorker({
      allowClaimInsert: false,
      fetchImpl: fakeRpcFetch(address),
    });
    const j = await loginWallet(w2);
    const res = await fetchWorker(
      "/v1/claims/receipt",
      {
        method: "POST",
        headers: {
          Origin: ORIGIN,
          "Content-Type": "application/json",
          Referer: ORIGIN + "/",
          Authorization: "Bearer " + j.accessToken,
          "X-CSRF-Token": j.csrf,
        },
        body: JSON.stringify({ chainId: 56, txHash: "0x" + "dd".repeat(32) }),
      },
      w2
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("grants_disabled");
    expect(body.verifiedPreview.purchaseUsd).toBe(1000);
  });

  it("wrong domain SIWE rejected; unauthenticated rejected", async () => {
    const ch = await fetchWorker("/v1/auth/wallet/challenge", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", Referer: ORIGIN + "/" },
      body: JSON.stringify({ address, chainId: 56 }),
    });
    const challenge = await ch.json();
    const evil = buildSiweMessage({
      domain: "evil.example",
      address,
      uri: challenge.uri,
      chainId: 56,
      nonce: challenge.nonce,
      issuedAt: challenge.issuedAt,
      expirationTime: challenge.expirationTime,
    });
    const signature = await signMessage(evil, priv);
    const ver = await fetchWorker("/v1/auth/wallet/verify", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", Referer: ORIGIN + "/" },
      body: JSON.stringify({ message: evil, signature, address, chainId: 56 }),
    });
    expect(ver.status).toBe(401);
    expect((await fetchWorker("/v1/claims")).status).toBe(401);
  });
});
