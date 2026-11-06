import { corsHeaders, requireSameSiteMutation } from "./lib/cors.js";
import { json, readJson } from "./lib/http.js";
import { POLICY, publicConfig, treasuryBuyPoints, classifyPurchaseTime, resolveAwardSeason, toInstantMs } from "./claims/policy.js";
import { verifySeedPurchaseReceipt, receiptVerificationStatus } from "./claims/receipts.js";
import { createIdentity, createSession, requireSession, loadSession } from "./auth/session.js";
import {
  buildSiweMessage,
  newChallengeTimes,
  verifySiwe,
  normalizeAddress,
} from "./auth/siwe.js";
import { xConfigStatus, beginXLoginBlocked, consumeOAuthState } from "./auth/x-oauth.js";
import { rateLimit } from "./lib/rate.js";
import { randomNonce } from "./lib/crypto.js";

function respond(env, request, body, status = 200, extra = {}) {
  const { headers: cors } = corsHeaders(env, request);
  const headers = { ...cors, ...extra };
  if (extra["Set-Cookie"]) {
    // multi cookie support via array
  }
  const res = json(body, status, headers);
  return res;
}

function respondWithCookies(env, request, body, status, cookies) {
  const { headers: cors } = corsHeaders(env, request);
  const headers = new Headers({ ...cors, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  for (const c of cookies || []) headers.append("Set-Cookie", c);
  return new Response(JSON.stringify(body), { status, headers });
}

async function ensureMigrated(env) {
  // Migrations applied via wrangler / API; local vitest applies schema in setup.
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      const { ok, headers } = corsHeaders(env, request);
      return new Response(null, { status: ok ? 204 : 403, headers });
    }

    try {
      if (path === "/health" && request.method === "GET") {
        return respond(env, request, {
          ok: true,
          service: "onmx-gamification-claims",
          time: new Date().toISOString(),
        });
      }

      if (path === "/v1/config" && request.method === "GET") {
        return respond(env, request, { ok: true, ...publicConfig(env), x: xConfigStatus(env), receipts: receiptVerificationStatus(env) });
      }

      // --- X OAuth (fail closed) ---
      if (path === "/v1/auth/x/start" && request.method === "POST") {
        const blocked = beginXLoginBlocked(env);
        return respond(env, request, blocked.body, blocked.status);
      }
      if (path === "/v1/auth/x/callback" && request.method === "GET") {
        const blocked = beginXLoginBlocked(env);
        return respond(env, request, blocked.body, blocked.status);
      }

      // --- Wallet SIWE challenge ---
      if (path === "/v1/auth/wallet/challenge" && request.method === "POST") {
        const csrf = requireSameSiteMutation(env, request);
        if (!csrf.ok) return respond(env, request, { ok: false, error: csrf.error }, 403);
        if (!env.SESSION_SECRET) return respond(env, request, { ok: false, error: "server_misconfigured", missing: ["SESSION_SECRET"] }, 503);

        const rl = await rateLimit(env.DB, `chal:${request.headers.get("CF-Connecting-IP") || "local"}`, 30, 60_000);
        if (!rl.ok) return respond(env, request, { ok: false, error: "rate_limited" }, 429);

        const body = await readJson(request);
        const address = normalizeAddress(body.address);
        const chainId = Number(body.chainId || 56);
        if (!address) return respond(env, request, { ok: false, error: "invalid_address" }, 400);
        if (![1, 56].includes(chainId)) return respond(env, request, { ok: false, error: "unsupported_chain" }, 400);

        const { nonce, issuedAt, expirationTime } = newChallengeTimes();
        const domain = env.SIWE_DOMAIN || "onchain-matrix.github.io";
        const uri = env.SIWE_URI || "https://onchain-matrix.github.io/onmx-gamification/";
        const message = buildSiweMessage({ domain, address, uri, chainId, nonce, issuedAt, expirationTime });

        await env.DB.prepare(
          `INSERT INTO auth_nonces (nonce, purpose, payload_json, created_at, expires_at)
           VALUES (?, 'siwe', ?, ?, ?)`
        )
          .bind(nonce, JSON.stringify({ address, chainId, domain, uri }), issuedAt, expirationTime)
          .run();

        return respond(env, request, {
          ok: true,
          domain,
          uri,
          chainId,
          address,
          nonce,
          issuedAt,
          expirationTime,
          message,
          note: "Wallet link is optional seed-claim identity bridge only. Ordinary play does not require a wallet. Signature does not prove X ownership.",
        });
      }

      // --- Wallet SIWE verify ---
      if (path === "/v1/auth/wallet/verify" && request.method === "POST") {
        const csrfGate = requireSameSiteMutation(env, request);
        if (!csrfGate.ok) return respond(env, request, { ok: false, error: csrfGate.error }, 403);
        if (!env.SESSION_SECRET) return respond(env, request, { ok: false, error: "server_misconfigured" }, 503);

        const body = await readJson(request);
        const { message, signature, address, chainId } = body;
        const addr = normalizeAddress(address);
        if (!addr || !message || !signature) return respond(env, request, { ok: false, error: "invalid_payload" }, 400);

        const parsedNonce = (message.match(/\nNonce: (.+)\n/) || [])[1];
        if (!parsedNonce) return respond(env, request, { ok: false, error: "siwe_parse" }, 400);

        const nonceRow = await env.DB.prepare(
          `SELECT nonce, payload_json, expires_at, consumed_at FROM auth_nonces WHERE nonce = ? AND purpose = 'siwe'`
        )
          .bind(parsedNonce)
          .first();
        if (!nonceRow) return respond(env, request, { ok: false, error: "nonce_unknown" }, 400);
        if (nonceRow.consumed_at) return respond(env, request, { ok: false, error: "nonce_replay" }, 409);
        if (Date.parse(nonceRow.expires_at) < Date.now()) return respond(env, request, { ok: false, error: "nonce_expired" }, 400);

        const payload = JSON.parse(nonceRow.payload_json);
        const domain = env.SIWE_DOMAIN || "onchain-matrix.github.io";
        const uri = env.SIWE_URI || "https://onchain-matrix.github.io/onmx-gamification/";

        const verified = await verifySiwe({
          message,
          signature,
          expectedDomain: domain,
          expectedUri: uri,
          expectedAddress: addr,
          expectedNonce: parsedNonce,
          expectedChainId: Number(chainId || payload.chainId),
        });
        if (!verified.ok) return respond(env, request, { ok: false, error: verified.error, eip1271: verified.eip1271 }, 401);

        const consume = await env.DB.prepare(
          `UPDATE auth_nonces SET consumed_at = ? WHERE nonce = ? AND consumed_at IS NULL`
        )
          .bind(new Date().toISOString(), parsedNonce)
          .run();
        if (!consume.meta?.changes) return respond(env, request, { ok: false, error: "nonce_replay" }, 409);

        // Link or create identity for this wallet+chain (atomic uniqueness)
        let identityId;
        const existing = await env.DB.prepare(
          `SELECT identity_id FROM wallet_links WHERE chain_id = ? AND address = ?`
        )
          .bind(verified.chainId, verified.address)
          .first();

        const sess = await loadSession(env, env.DB, request);
        if (existing) {
          identityId = existing.identity_id;
          if (sess && sess.identityId !== identityId) {
            return respond(env, request, { ok: false, error: "wallet_bound_other_identity" }, 409);
          }
        } else if (sess) {
          identityId = sess.identityId;
          try {
            await env.DB.prepare(
              `INSERT INTO wallet_links (identity_id, chain_id, address, linked_at) VALUES (?, ?, ?, ?)`
            )
              .bind(identityId, verified.chainId, verified.address, new Date().toISOString())
              .run();
          } catch (e) {
            return respond(env, request, { ok: false, error: "wallet_link_conflict" }, 409);
          }
        } else {
          identityId = await createIdentity(env.DB);
          await env.DB.prepare(
            `INSERT INTO wallet_links (identity_id, chain_id, address, linked_at) VALUES (?, ?, ?, ?)`
          )
            .bind(identityId, verified.chainId, verified.address, new Date().toISOString())
            .run();
        }

        const session = await createSession(env, env.DB, identityId, request);
        return respondWithCookies(
          env,
          request,
          {
            ok: true,
            identityId,
            address: verified.address,
            chainId: verified.chainId,
            csrf: session.csrf,
            note: "Session established. Wallet signature does not prove X ownership or single-human uniqueness.",
          },
          200,
          session.setCookies
        );
      }

      // --- Session me / claims ---
      if (path === "/v1/me" && request.method === "GET") {
        const auth = await requireSession(env, env.DB, request, { requireCsrf: false });
        if (!auth.ok) return respond(env, request, { ok: false, error: auth.error }, auth.status);
        const wallets = await env.DB.prepare(
          `SELECT chain_id, address, linked_at FROM wallet_links WHERE identity_id = ?`
        )
          .bind(auth.session.identityId)
          .all();
        const x = await env.DB.prepare(`SELECT x_user_id, x_username, linked_at FROM x_links WHERE identity_id = ?`)
          .bind(auth.session.identityId)
          .first();
        return respond(env, request, {
          ok: true,
          identityId: auth.session.identityId,
          csrf: auth.session.csrf,
          wallets: wallets.results || [],
          x: x ? { xUserId: x.x_user_id, username: x.x_username, linkedAt: x.linked_at } : null,
        });
      }

      if (path === "/v1/claims" && request.method === "GET") {
        const auth = await requireSession(env, env.DB, request, { requireCsrf: false });
        if (!auth.ok) return respond(env, request, { ok: false, error: auth.error }, auth.status);
        const rows = await env.DB.prepare(
          `SELECT id, chain_id, tx_hash, log_index, receipt_status, purchase_usd,
                  purchase_season, award_season, queue_reason, formula_version, policy_version,
                  points_raw, created_at
           FROM purchase_claims WHERE identity_id = ? ORDER BY created_at ASC`
        )
          .bind(auth.session.identityId)
          .all();
        return respond(env, request, {
          ok: true,
          identityId: auth.session.identityId,
          claims: rows.results || [],
          note: "Points are server snapshots. Rankings on the static dashboard remain fixtures unless distinctly labeled verified ledger scores.",
        });
      }

      // --- Receipt claim (fail closed for live verification; fixture path only in tests via env) ---
      if (path === "/v1/claims/receipt" && request.method === "POST") {
        const csrfGate = requireSameSiteMutation(env, request);
        if (!csrfGate.ok) return respond(env, request, { ok: false, error: csrfGate.error }, 403);
        const auth = await requireSession(env, env.DB, request, { requireCsrf: true });
        if (!auth.ok) return respond(env, request, { ok: false, error: auth.error }, auth.status);

        const body = await readJson(request);

        // Production: always fail closed on chain verification
        if (env.ALLOW_TEST_FIXTURE_RECEIPTS !== "1") {
          const v = await verifySeedPurchaseReceipt(env, body);
          return respond(env, request, { ok: false, error: v.error, verification: v.verification }, v.status);
        }

        // Isolated test fixtures only (never production)
        return await insertFixtureClaim(env, auth.session.identityId, body, request);
      }

      // OAuth state consume helper for tests / future
      if (path === "/v1/auth/x/state/consume" && request.method === "POST") {
        const body = await readJson(request);
        const r = await consumeOAuthState(env.DB, body.state || "");
        return respond(env, request, r, r.ok ? 200 : 409);
      }

      return respond(env, request, { ok: false, error: "not_found" }, 404);
    } catch (err) {
      const status = err.status || 500;
      const msg = String(err && (err.message || err));
      return respond(env, request, { ok: false, error: msg || "internal_error" }, status);
    }
  },
};
async function insertFixtureClaim(env, identityId, body, request) {
  const purchaseUsd = Number(body.purchaseUsd);
  const purchaseAt = body.purchaseAt ? Date.parse(body.purchaseAt) : Date.now();
  if (!Number.isFinite(purchaseUsd) || purchaseUsd <= 0) {
    return respond(env, request, { ok: false, error: "invalid_purchase_usd" }, 400);
  }
  const chainId = Number(body.chainId || 56);
  const txHash = String(body.txHash || "").toLowerCase();
  const logIndex = Number(body.logIndex ?? 0);
  if (!/^0x[0-9a-f]{64}$/.test(txHash)) return respond(env, request, { ok: false, error: "invalid_tx_hash" }, 400);

  const points = treasuryBuyPoints(purchaseUsd);
  const classification = classifyPurchaseTime(purchaseAt);
  const existing = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM purchase_claims
     WHERE identity_id = ? AND purchase_season = ? AND award_season = ?`
  )
    .bind(identityId, POLICY.seasonNumber, POLICY.seasonNumber)
    .first();
  const resolved = resolveAwardSeason({
    classification,
    existingCurrentSeasonClaims: Number(existing?.c || 0),
  });

  const id = "pc_" + randomNonce().slice(0, 24);
  const pointsRaw = resolved.pointsApply ? points : 0;

  try {
    await env.DB.prepare(
      `INSERT INTO purchase_claims (
         id, identity_id, chain_id, tx_hash, log_index, receipt_status, purchase_usd,
         purchase_season, award_season, queue_reason, formula_version, policy_version,
         points_raw, created_at
       ) VALUES (?, ?, ?, ?, ?, 'fixture_test_only', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        identityId,
        chainId,
        txHash,
        logIndex,
        purchaseUsd,
        resolved.purchaseSeason,
        resolved.awardSeason,
        resolved.queueReason,
        POLICY.formulaVersion,
        POLICY.version,
        pointsRaw,
        new Date().toISOString()
      )
      .run();
  } catch (e) {
    const msg = String(e.message || e);
    if (/UNIQUE|unique/i.test(msg)) return respond(env, request, { ok: false, error: "duplicate_receipt" }, 409);
    throw e;
  }

  return respond(env, request, {
    ok: true,
    claim: {
      id,
      purchaseUsd,
      pointsRaw,
      formulaVersion: POLICY.formulaVersion,
      purchaseSeason: resolved.purchaseSeason,
      awardSeason: resolved.awardSeason,
      queueReason: resolved.queueReason,
      receiptStatus: "fixture_test_only",
    },
    warning: "TEST FIXTURE ONLY — not a verified live purchase",
  });
}
