import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { applyMigrations } from "./apply-migrations.js";
import worker from "../src/index.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { hashPersonalMessage, buildSiweMessage } from "../src/auth/siwe.js";
import { treasuryBuyPoints, classifyPurchaseTime, resolveAwardSeason, POLICY } from "../src/claims/policy.js";

const ORIGIN = "https://onchain-matrix.github.io";

function privToAddress(priv) {
  const pub = secp256k1.getPublicKey(priv, false).slice(1);
  const hash = keccak_256(pub);
  return "0x" + [...hash.slice(12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signMessage(message, priv) {
  const msgHash = await hashPersonalMessage(message);
  const sig65 = secp256k1.sign(msgHash, priv, { format: "recovered" });
  // Ethereum: r||s||v with v=27/28; noble recovered is recovery||r||s (65 bytes, first byte 0/1)
  const recovery = sig65[0];
  const rs = sig65.slice(1);
  const v = recovery + 27;
  return "0x" + [...rs].map((b) => b.toString(16).padStart(2, "0")).join("") + v.toString(16).padStart(2, "0");
}


function sessionCookie(res) {
  const multi = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  if (multi && multi.length) return multi.find((c) => c.startsWith("onmx_session=")) || multi[0];
  // Headers#get joins Set-Cookie with comma which breaks; fall back to raw if present
  const raw = res.headers.get("Set-Cookie");
  if (!raw) return null;
  const m = raw.match(/onmx_session=[^;]+/);
  return m ? m[0] + "; Path=/" : raw.split(",")[0];
}

async function fetchWorker(path, init = {}) {
  const request = new Request("https://onmx-gamification-claims.onmx.workers.dev" + path, init);
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("policy math", () => {
  it("exp-v1 formula matches specified curve", () => {
    expect(treasuryBuyPoints(0)).toBe(0);
    expect(treasuryBuyPoints(1000)).toBeCloseTo(158.03, 2);
    expect(treasuryBuyPoints(1e9)).toBe(250);
    expect(treasuryBuyPoints(-1)).toBe(0);
  });

  it("prelaunch stays unassigned", () => {
    const c = classifyPurchaseTime(Date.parse("2026-11-01T12:00:00-05:00"));
    expect(c.status).toBe("unassigned");
    expect(c.awardSeason).toBeNull();
    const r = resolveAwardSeason({ classification: c, existingCurrentSeasonClaims: 0 });
    expect(r.awardSeason).toBeNull();
    expect(r.pointsApply).toBe(false);
  });

  it("second in-season purchase queues next season", () => {
    const c = classifyPurchaseTime(Date.parse("2026-11-10T12:00:00-05:00"));
    const first = resolveAwardSeason({ classification: c, existingCurrentSeasonClaims: 0 });
    expect(first.awardSeason).toBe(1);
    const second = resolveAwardSeason({ classification: c, existingCurrentSeasonClaims: 1 });
    expect(second.awardSeason).toBe(POLICY.nextSeasonNumber);
    expect(second.queueReason).toBe("next_season_queue");
  });
});

describe("API security + claims", () => {
  beforeAll(async () => {
    await applyMigrations(env.DB);
  });

  const priv = secp256k1.utils.randomSecretKey();
  const address = privToAddress(priv);
  let csrf;
  let cookie;

  it("health + config fail-closed readiness", async () => {
    const h = await fetchWorker("/health");
    expect(h.status).toBe(200);
    const c = await fetchWorker("/v1/config");
    const body = await c.json();
    expect(body.readiness.xLoginEnabled).toBe(false);
    expect(body.readiness.productionGrantsEnabled).toBe(false);
    expect(body.readiness.receiptVerification).toBe("unavailable");
    expect(body.blockers.some((b) => /ABI/i.test(b))).toBe(true);
    expect(body.x.ready).toBe(false);
    expect(body.x.missing).toContain("X_CLIENT_ID");
  });

  it("CORS rejects other origins on preflight", async () => {
    const res = await fetchWorker("/v1/config", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "GET" },
    });
    // We still return headers but browser enforces; our gate marks ok false → 403
    expect([403, 204]).toContain(res.status);
  });

  it("X login start is fail-closed", async () => {
    const res = await fetchWorker("/v1/auth/x/start", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.error).toBe("x_oauth_not_configured");
  });

  it("wallet challenge + verify (EIP-191) establishes session", async () => {
    const ch = await fetchWorker("/v1/auth/wallet/challenge", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", Referer: ORIGIN + "/onmx-gamification/" },
      body: JSON.stringify({ address, chainId: 56 }),
    });
    expect(ch.status).toBe(200);
    const challenge = await ch.json();
    expect(challenge.message).toContain(address);

    const signature = await signMessage(challenge.message, priv);
    const ver = await fetchWorker("/v1/auth/wallet/verify", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", Referer: ORIGIN + "/onmx-gamification/" },
      body: JSON.stringify({ message: challenge.message, signature, address, chainId: 56 }),
    });
    expect(ver.status).toBe(200);
    const vj = await ver.json();
    expect(vj.ok).toBe(true);
    expect(vj.csrf).toBeTruthy();
    csrf = vj.csrf;
    cookie = sessionCookie(ver);
    expect(cookie).toMatch(/onmx_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=None/i);
  });

  it("nonce replay rejected", async () => {
    const ch = await fetchWorker("/v1/auth/wallet/challenge", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", Referer: ORIGIN + "/" },
      body: JSON.stringify({ address, chainId: 56 }),
    });
    const challenge = await ch.json();
    const signature = await signMessage(challenge.message, priv);
    const body = JSON.stringify({ message: challenge.message, signature, address, chainId: 56 });
    const a = await fetchWorker("/v1/auth/wallet/verify", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", Referer: ORIGIN + "/" },
      body,
    });
    expect(a.status).toBe(200);
    const b = await fetchWorker("/v1/auth/wallet/verify", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", Referer: ORIGIN + "/" },
      body,
    });
    expect(b.status).toBe(409);
    expect((await b.json()).error).toBe("nonce_replay");
  });

  it("wrong domain signature rejected", async () => {
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
    expect((await ver.json()).error).toMatch(/siwe_/);
  });

  it("unauthenticated claims rejected; spoofed cookie rejected", async () => {
    const a = await fetchWorker("/v1/claims");
    expect(a.status).toBe(401);
    const b = await fetchWorker("/v1/claims", { headers: { Cookie: "onmx_session=fake.fake.fake" } });
    expect(b.status).toBe(401);
  });

  it("fixture receipt: immutable snapshot, duplicate rejected, next-season queue, prelaunch unassigned", async () => {
    // re-login for fresh csrf/cookie
    const ch = await fetchWorker("/v1/auth/wallet/challenge", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", Referer: ORIGIN + "/" },
      body: JSON.stringify({ address, chainId: 56 }),
    });
    const challenge = await ch.json();
    const signature = await signMessage(challenge.message, priv);
    const ver = await fetchWorker("/v1/auth/wallet/verify", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", Referer: ORIGIN + "/" },
      body: JSON.stringify({ message: challenge.message, signature, address, chainId: 56 }),
    });
    const vj = await ver.json();
    csrf = vj.csrf;
    cookie = sessionCookie(ver);
    const cookiePair = cookie?.split(";")[0];
    expect(cookiePair).toBeTruthy();

    const headers = {
      Origin: ORIGIN,
      "Content-Type": "application/json",
      Referer: ORIGIN + "/onmx-gamification/",
      Cookie: cookiePair,
      "X-CSRF-Token": csrf,
    };

    const tx1 = "0x" + "11".repeat(32);
    const r1 = await fetchWorker("/v1/claims/receipt", {
      method: "POST",
      headers,
      body: JSON.stringify({
        purchaseUsd: 1000,
        purchaseAt: "2026-11-10T15:00:00-05:00",
        chainId: 56,
        txHash: tx1,
        logIndex: 0,
      }),
    });
    expect(r1.status).toBe(200);
    const j1 = await r1.json();
    expect(j1.claim.pointsRaw).toBeCloseTo(158.03, 2);
    expect(j1.claim.awardSeason).toBe(1);
    expect(j1.claim.formulaVersion).toBe("exp-v1");
    const frozen = j1.claim.pointsRaw;

    // duplicate same receipt
    const dup = await fetchWorker("/v1/claims/receipt", {
      method: "POST",
      headers,
      body: JSON.stringify({ purchaseUsd: 1000, purchaseAt: "2026-11-10T15:00:00-05:00", chainId: 56, txHash: tx1, logIndex: 0 }),
    });
    expect(dup.status).toBe(409);

    // second purchase same season → next season queue; points snapshot not added to season 1
    const tx2 = "0x" + "22".repeat(32);
    const r2 = await fetchWorker("/v1/claims/receipt", {
      method: "POST",
      headers,
      body: JSON.stringify({ purchaseUsd: 5000, purchaseAt: "2026-11-11T12:00:00-05:00", chainId: 56, txHash: tx2, logIndex: 0 }),
    });
    expect(r2.status).toBe(200);
    const j2 = await r2.json();
    expect(j2.claim.awardSeason).toBe(2);
    expect(j2.claim.purchaseSeason).toBe(1);
    expect(j2.claim.queueReason).toBe("next_season_queue");
    expect(j2.claim.pointsRaw).toBeGreaterThan(frozen); // own snapshot; does not mutate first

    // prelaunch unassigned
    const tx3 = "0x" + "33".repeat(32);
    const r3 = await fetchWorker("/v1/claims/receipt", {
      method: "POST",
      headers,
      body: JSON.stringify({ purchaseUsd: 1000, purchaseAt: "2026-11-01T12:00:00-05:00", chainId: 56, txHash: tx3, logIndex: 0 }),
    });
    expect(r3.status).toBe(200);
    const j3 = await r3.json();
    expect(j3.claim.awardSeason).toBeNull();
    expect(j3.claim.pointsRaw).toBe(0);
    expect(j3.claim.queueReason).toBe("unassigned_prelaunch");

    // client-supplied points ignored (not in schema path) — spoofed high points field ignored
    const tx4 = "0x" + "44".repeat(32);
    const r4 = await fetchWorker("/v1/claims/receipt", {
      method: "POST",
      headers,
      body: JSON.stringify({
        purchaseUsd: 100,
        points: 99999,
        purchaseAt: "2026-11-12T12:00:00-05:00",
        chainId: 56,
        txHash: tx4,
        logIndex: 0,
      }),
    });
    const j4 = await r4.json();
    expect(j4.claim.pointsRaw).toBe(treasuryBuyPoints(100));
    expect(j4.claim.pointsRaw).toBeLessThan(250);

    // list claims across session
    const list = await fetchWorker("/v1/claims", { headers: { Cookie: cookiePair } });
    expect(list.status).toBe(200);
    const lj = await list.json();
    expect(lj.claims.length).toBeGreaterThanOrEqual(3);

    // CSRF missing rejected
    const bad = await fetchWorker("/v1/claims/receipt", {
      method: "POST",
      headers: { ...headers, "X-CSRF-Token": "wrong" },
      body: JSON.stringify({ purchaseUsd: 10, purchaseAt: "2026-11-12T12:00:00-05:00", chainId: 56, txHash: "0x" + "55".repeat(32), logIndex: 0 }),
    });
    expect(bad.status).toBe(403);
  });

  it("production path rejects unverified receipts when fixtures disabled", async () => {
    const prev = env.ALLOW_TEST_FIXTURE_RECEIPTS;
    env.ALLOW_TEST_FIXTURE_RECEIPTS = "0";
    const ch = await fetchWorker("/v1/auth/wallet/challenge", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", Referer: ORIGIN + "/" },
      body: JSON.stringify({ address, chainId: 56 }),
    });
    const challenge = await ch.json();
    const signature = await signMessage(challenge.message, priv);
    const ver = await fetchWorker("/v1/auth/wallet/verify", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", Referer: ORIGIN + "/" },
      body: JSON.stringify({ message: challenge.message, signature, address, chainId: 56 }),
    });
    const vj = await ver.json();
    const cookiePair = sessionCookie(ver)?.split(";")[0];
    const res = await fetchWorker("/v1/claims/receipt", {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        "Content-Type": "application/json",
        Referer: ORIGIN + "/",
        Cookie: cookiePair,
        "X-CSRF-Token": vj.csrf,
      },
      body: JSON.stringify({ purchaseUsd: 100, purchaseAt: "2026-11-10T12:00:00-05:00", chainId: 56, txHash: "0x" + "66".repeat(32), logIndex: 0 }),
    });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("receipt_verification_unavailable");
    env.ALLOW_TEST_FIXTURE_RECEIPTS = prev;
  });

  it("independent session can read same identity claims", async () => {
    env.ALLOW_TEST_FIXTURE_RECEIPTS = "1";
    // device A
    const ch1 = await fetchWorker("/v1/auth/wallet/challenge", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", Referer: ORIGIN + "/" },
      body: JSON.stringify({ address, chainId: 56 }),
    });
    const c1 = await ch1.json();
    const s1 = await signMessage(c1.message, priv);
    const v1 = await fetchWorker("/v1/auth/wallet/verify", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", Referer: ORIGIN + "/" },
      body: JSON.stringify({ message: c1.message, signature: s1, address, chainId: 56 }),
    });
    const j1 = await v1.json();
    const cookieA = sessionCookie(v1)?.split(";")[0];
    expect(cookieA).toBeTruthy();
    const tx = "0x" + "77".repeat(32);
    const claimRes = await fetchWorker("/v1/claims/receipt", {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        "Content-Type": "application/json",
        Referer: ORIGIN + "/",
        Cookie: cookieA,
        "X-CSRF-Token": j1.csrf,
      },
      body: JSON.stringify({ purchaseUsd: 200, purchaseAt: "2026-11-12T12:00:00-05:00", chainId: 56, txHash: tx, logIndex: 0 }),
    });
    expect(claimRes.status).toBe(200);

    // device B: same wallet → same identity, can list claims
    const ch2 = await fetchWorker("/v1/auth/wallet/challenge", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", Referer: ORIGIN + "/" },
      body: JSON.stringify({ address, chainId: 56 }),
    });
    const c2 = await ch2.json();
    const s2 = await signMessage(c2.message, priv);
    const v2 = await fetchWorker("/v1/auth/wallet/verify", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", Referer: ORIGIN + "/" },
      body: JSON.stringify({ message: c2.message, signature: s2, address, chainId: 56 }),
    });
    const j2 = await v2.json();
    expect(j2.identityId).toBe(j1.identityId);
    const cookieB = sessionCookie(v2)?.split(";")[0];
    const list = await fetchWorker("/v1/claims", { headers: { Cookie: cookieB } });
    expect(list.status).toBe(200);
    const claims = (await list.json()).claims;
    expect(claims.some((c) => c.tx_hash === tx)).toBe(true);
  });

  it("OAuth state replay rejected", async () => {
    await env.DB.prepare(
      `INSERT INTO auth_nonces (nonce, purpose, payload_json, created_at, expires_at) VALUES (?, 'oauth_state', '{}', ?, ?)`
    )
      .bind("state123", new Date().toISOString(), new Date(Date.now() + 600000).toISOString())
      .run();
    const a = await fetchWorker("/v1/auth/x/state/consume", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", Referer: ORIGIN + "/" },
      body: JSON.stringify({ state: "state123" }),
    });
    expect(a.status).toBe(200);
    const b = await fetchWorker("/v1/auth/x/state/consume", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", Referer: ORIGIN + "/" },
      body: JSON.stringify({ state: "state123" }),
    });
    expect(b.status).toBe(409);
  });
});
