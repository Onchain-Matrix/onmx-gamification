import { corsHeaders, requireSameSiteMutation } from "./lib/cors.js";
import { json, readJson } from "./lib/http.js";
import { POLICY, publicConfig } from "./claims/policy.js";
import { verifySeedPurchaseReceipt, receiptVerificationStatus } from "./claims/receipts.js";
import { insertVerifiedClaim } from "./claims/ledger.js";
import {
  createIdentity,
  createSession,
  requireSession,
  loadSession,
  createHandoff,
  consumeHandoff,
  handoffPostMessageHtml,
} from "./auth/session.js";
import {
  buildSiweMessage,
  newChallengeTimes,
  verifySiwe,
  normalizeAddress,
  recoverPersonalSignature,
  hashPersonalMessage,
} from "./auth/siwe.js";
import { verifyEip1271 } from "./claims/receipts.js";
import {
  xConfigStatus,
  beginXLoginBlocked,
  startXOAuth,
  completeXCallback,
  consumeOAuthState,
  DEFAULT_ENDPOINTS,
} from "./auth/x-oauth.js";
import { rateLimit } from "./lib/rate.js";
import {
  signalsPublicConfig,
  requireAdmin,
  handleRegister,
  handleMe,
  handleSubmit,
  handleResolveRef,
  handleLeaderboard,
  adminList,
  adminApprove,
  adminReject,
  adminOutcomes,
  adminRevoke,
  adminCsv,
  adminPlayers,
  adminDeletePlayer,
  adminPurgePreview,
} from "./signals/handlers.js";

function respond(env, request, body, status = 200) {
  const { headers: cors } = corsHeaders(env, request);
  return json(body, status, cors);
}

function respondWithCookies(env, request, body, status, cookies) {
  const { headers: cors } = corsHeaders(env, request);
  const headers = new Headers({
    ...cors,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  for (const c of cookies || []) headers.append("Set-Cookie", c);
  return new Response(JSON.stringify(body), { status, headers });
}

function html(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

/** Link verified X user id to identity (unique). */
async function linkXUser(db, { identityId, xUserId, username }) {
  const existing = await db.prepare(`SELECT identity_id FROM x_links WHERE x_user_id = ?`).bind(xUserId).first();
  if (existing && existing.identity_id !== identityId) {
    return { ok: false, error: "x_user_bound_other_identity" };
  }
  const mine = await db.prepare(`SELECT x_user_id FROM x_links WHERE identity_id = ?`).bind(identityId).first();
  if (mine && mine.x_user_id !== xUserId) {
    return { ok: false, error: "identity_has_other_x_user" };
  }
  if (!existing) {
    await db
      .prepare(
        `INSERT INTO x_links (identity_id, x_user_id, x_username, linked_at) VALUES (?, ?, ?, ?)`
      )
      .bind(identityId, xUserId, username, new Date().toISOString())
      .run();
  } else if (username) {
    await db
      .prepare(`UPDATE x_links SET x_username = ? WHERE x_user_id = ?`)
      .bind(username, xUserId)
      .run();
  }
  return { ok: true };
}

async function resolveWalletIdentity(db, sess, verified) {
  const existing = await db
    .prepare(`SELECT identity_id FROM wallet_links WHERE chain_id = ? AND address = ?`)
    .bind(verified.chainId, verified.address)
    .first();
  if (existing) {
    if (sess && sess.identityId !== existing.identity_id) {
      return { ok: false, error: "wallet_bound_other_identity", status: 409 };
    }
    return { ok: true, identityId: existing.identity_id };
  }
  let identityId;
  if (sess) {
    identityId = sess.identityId;
  } else {
    identityId = await createIdentity(db);
  }
  try {
    await db
      .prepare(`INSERT INTO wallet_links (identity_id, chain_id, address, linked_at) VALUES (?, ?, ?, ?)`)
      .bind(identityId, verified.chainId, verified.address, new Date().toISOString())
      .run();
  } catch {
    return { ok: false, error: "wallet_link_conflict", status: 409 };
  }
  return { ok: true, identityId };
}

/**
 * Optional injectable deps for tests (fake X provider / mock claim verifier).
 * Production deploy never sets CLAIM_VERIFIER — always fail-closed receipts.js.
 */
export function createWorker(deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const endpoints = deps.xEndpoints || DEFAULT_ENDPOINTS;
  // claimVerifier(env, body) → { ok, purchaseUsd, purchaseAtMs, chainId, txHash, logIndex } or fail
  const claimVerifier = deps.claimVerifier || ((env, input, opts) => verifySeedPurchaseReceipt(env, input, opts));
  const allowClaimInsert = !!deps.allowClaimInsert;

  return {
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
          return respond(env, request, {
            ok: true,
            ...publicConfig(env),
            x: xConfigStatus(env),
            receipts: receiptVerificationStatus(env),
            signals: signalsPublicConfig(env),
          });
        }

        // --- Matrix Signals + referral (player) ---
        if (path === "/v1/signals/register" && request.method === "POST") {
          const g = requireSameSiteMutation(env, request);
          if (!g.ok) return respond(env, request, { ok: false, error: g.error }, 403);
          const [st, body] = await handleRegister(env, request, await readJson(request, 4_000));
          return respond(env, request, body, st);
        }
        if (path === "/v1/signals/me" && request.method === "GET") {
          const [st, body] = await handleMe(env, request);
          return respond(env, request, body, st);
        }
        if (path === "/v1/signals" && request.method === "POST") {
          const g = requireSameSiteMutation(env, request);
          if (!g.ok) return respond(env, request, { ok: false, error: g.error }, 403);
          const [st, body] = await handleSubmit(env, request, await readJson(request, 8_000));
          return respond(env, request, body, st);
        }
        if (path === "/v1/leaderboard" && request.method === "GET") {
          const [st, body] = await handleLeaderboard(env, request, url);
          const { headers: cors } = corsHeaders(env, request);
          const pv = !!body.preview;
          return json(body, st, { ...cors, "cache-control": pv ? "no-store" : "public, max-age=30" });
        }
        if (path === "/v1/referral/resolve" && request.method === "GET") {
          const [st, body] = await handleResolveRef(env, url);
          return respond(env, request, body, st);
        }

        // --- Matrix Signals review (admin token) ---
        if (path.startsWith("/v1/admin/")) {
          const auth = await requireAdmin(env, request);
          if (!auth.ok) return respond(env, request, { ok: false, error: auth.error }, auth.status);
          if (request.method === "POST") {
            const g = requireSameSiteMutation(env, request);
            if (!g.ok) return respond(env, request, { ok: false, error: g.error }, 403);
          }
          if (path === "/v1/admin/ping" && request.method === "GET") {
            return respond(env, request, { ok: true, admin: true, signals: signalsPublicConfig(env) });
          }
          if (path === "/v1/admin/signals" && request.method === "GET") {
            const [st, body] = await adminList(env, url);
            return respond(env, request, body, st);
          }
          if (path === "/v1/admin/signals.csv" && request.method === "GET") {
            const { headers: cors } = corsHeaders(env, request);
            return new Response(await adminCsv(env, url), {
              status: 200,
              headers: { ...cors, "content-type": "text/csv; charset=utf-8", "cache-control": "no-store",
                "content-disposition": `attachment; filename="matrix-signals-log.csv"` },
            });
          }
          const m = path.match(/^\/v1\/admin\/signals\/([a-f0-9]{32})\/(approve|reject|outcomes|revoke)$/);
          if (m && request.method === "POST") {
            const body = await readJson(request, 8_000);
            const fn = { approve: adminApprove, reject: adminReject, outcomes: adminOutcomes, revoke: adminRevoke }[m[2]];
            const [st, out] = await fn(env, m[1], body);
            return respond(env, request, out, st);
          }
          if (path === "/v1/admin/players" && request.method === "GET") {
            const [st, body] = await adminPlayers(env, url);
            return respond(env, request, body, st);
          }
          const d = path.match(/^\/v1\/admin\/players\/([a-f0-9]{32})\/delete$/);
          if (d && request.method === "POST") {
            const [st, body] = await adminDeletePlayer(env, d[1]);
            return respond(env, request, body, st);
          }
          if (path === "/v1/admin/purge-preview" && request.method === "POST") {
            const [st, body] = await adminPurgePreview(env);
            return respond(env, request, body, st);
          }
          return respond(env, request, { ok: false, error: "not_found" }, 404);
        }

        // --- X OAuth PKCE start ---
        if (path === "/v1/auth/x/start" && request.method === "POST") {
          const csrfGate = requireSameSiteMutation(env, request);
          if (!csrfGate.ok) return respond(env, request, { ok: false, error: csrfGate.error }, 403);
          if (!env.SESSION_SECRET) {
            return respond(env, request, { ok: false, error: "server_misconfigured", missing: ["SESSION_SECRET"] }, 503);
          }
          const body = await readJson(request);
          const sess = await loadSession(env, env.DB, request);
          const result = await startXOAuth(env, env.DB, {
            openerOrigin: body.openerOrigin || request.headers.get("Origin"),
            identityId: sess?.identityId || null,
            endpoints,
          });
          return respond(env, request, result.body, result.status);
        }

        // --- X OAuth callback (browser redirect) ---
        if (path === "/v1/auth/x/callback" && request.method === "GET") {
          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          const errParam = url.searchParams.get("error");
          if (errParam) {
            return html(handoffPostMessageHtml({ openerOrigin: "", handoffCode: null, error: errParam }));
          }
          if (!xConfigStatus(env).ready) {
            const blocked = beginXLoginBlocked(env);
            return respond(env, request, blocked.body, blocked.status);
          }
          const done = await completeXCallback(env, env.DB, { code, state, fetchImpl, endpoints });
          if (!done.ok) {
            return html(
              handoffPostMessageHtml({
                openerOrigin: env.ALLOWED_ORIGIN || "https://onchain-matrix.github.io",
                error: done.error,
              }),
              done.status === 503 ? 503 : 400
            );
          }

          // Resolve / create identity for this X user
          let identityId;
          const existingX = await env.DB.prepare(`SELECT identity_id FROM x_links WHERE x_user_id = ?`)
            .bind(done.xUserId)
            .first();
          if (existingX) {
            identityId = existingX.identity_id;
          } else {
            identityId = await createIdentity(env.DB);
            const link = await linkXUser(env.DB, {
              identityId,
              xUserId: done.xUserId,
              username: done.username,
            });
            if (!link.ok) return html(handoffPostMessageHtml({ openerOrigin: done.openerOrigin, error: link.error }), 409);
          }

          const session = await createSession(env, env.DB, identityId, request, { setCookie: false });
          const handoffCode = await createHandoff(env.DB, {
            sessionId: session.sessionId,
            identityId,
            csrf: session.csrf,
            openerOrigin: done.openerOrigin,
          });
          return html(
            handoffPostMessageHtml({ openerOrigin: done.openerOrigin, handoffCode }),
            200
          );
        }

        // --- Handoff → bearer token (response body only) ---
        if (path === "/v1/auth/session/exchange" && request.method === "POST") {
          const csrfGate = requireSameSiteMutation(env, request);
          if (!csrfGate.ok) return respond(env, request, { ok: false, error: csrfGate.error }, 403);
          const body = await readJson(request);
          const origin = request.headers.get("Origin") || body.openerOrigin || "";
          const r = await consumeHandoff(env, env.DB, { code: body.handoffCode || body.code, openerOrigin: origin });
          if (!r.ok) return respond(env, request, { ok: false, error: r.error }, r.status || 400);
          return respond(env, request, {
            ok: true,
            accessToken: r.accessToken,
            csrf: r.csrf,
            identityId: r.identityId,
            sessionMode: "bearer",
            note: "Store accessToken in JS memory only. Do not use localStorage/sessionStorage. Re-auth after reload is OK.",
          });
        }

        // --- Wallet SIWE challenge ---
        if (path === "/v1/auth/wallet/challenge" && request.method === "POST") {
          const csrf = requireSameSiteMutation(env, request);
          if (!csrf.ok) return respond(env, request, { ok: false, error: csrf.error }, 403);
          if (!env.SESSION_SECRET) {
            return respond(env, request, { ok: false, error: "server_misconfigured", missing: ["SESSION_SECRET"] }, 503);
          }
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
            `INSERT INTO auth_nonces (nonce, purpose, payload_json, created_at, expires_at) VALUES (?, 'siwe', ?, ?, ?)`
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
            note: "Wallet link is optional seed-claim identity bridge only. Ordinary play does not require a wallet.",
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

          let verified = await verifySiwe({
            message,
            signature,
            expectedDomain: domain,
            expectedUri: uri,
            expectedAddress: addr,
            expectedNonce: parsedNonce,
            expectedChainId: Number(chainId || payload.chainId),
          });

          // Optional EIP-1271 if EOA recover failed and RPC configured
          if (!verified.ok && verified.error === "siwe_bad_signature") {
            const rpc = Number(chainId || payload.chainId) === 1 ? env.ETH_RPC_URL : env.BNB_RPC_URL;
            if (rpc) {
              const msgHash = await hashPersonalMessage(message);
              const hashHex = "0x" + [...msgHash].map((b) => b.toString(16).padStart(2, "0")).join("");
              const eip = await verifyEip1271({
                rpcUrl: rpc,
                contractAddress: addr,
                messageHash: hashHex,
                signature,
                fetchImpl,
              });
              if (eip.ok) {
                verified = { ok: true, address: addr, chainId: Number(chainId || payload.chainId) };
              } else {
                return respond(env, request, { ok: false, error: "siwe_bad_signature", eip1271: eip.error }, 401);
              }
            } else {
              return respond(env, request, {
                ok: false,
                error: verified.error,
                eip1271: "unsupported_without_rpc",
              }, 401);
            }
          } else if (!verified.ok) {
            return respond(env, request, { ok: false, error: verified.error }, 401);
          }

          const consume = await env.DB.prepare(
            `UPDATE auth_nonces SET consumed_at = ? WHERE nonce = ? AND consumed_at IS NULL`
          )
            .bind(new Date().toISOString(), parsedNonce)
            .run();
          if (!consume.meta?.changes) return respond(env, request, { ok: false, error: "nonce_replay" }, 409);

          const sess = await loadSession(env, env.DB, request);
          const resolved = await resolveWalletIdentity(env.DB, sess, verified);
          if (!resolved.ok) return respond(env, request, { ok: false, error: resolved.error }, resolved.status || 409);

          const session = await createSession(env, env.DB, resolved.identityId, request, { setCookie: true });
          return respondWithCookies(
            env,
            request,
            {
              ok: true,
              identityId: resolved.identityId,
              address: verified.address,
              chainId: verified.chainId,
              csrf: session.csrf,
              accessToken: session.accessToken,
              sessionMode: "bearer_preferred",
              note: "Prefer Authorization: Bearer accessToken for Pages→Worker. Cookie may be blocked cross-site. Wallet signature does not prove X ownership.",
            },
            200,
            session.setCookies
          );
        }

        // --- me / claims ---
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
            sessionVia: auth.session.via,
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

        // --- Receipt claim: production verifier fail-closed; tests inject claimVerifier ---
        if (path === "/v1/claims/receipt" && request.method === "POST") {
          const csrfGate = requireSameSiteMutation(env, request);
          if (!csrfGate.ok) return respond(env, request, { ok: false, error: csrfGate.error }, 403);
          const auth = await requireSession(env, env.DB, request, { requireCsrf: true });
          if (!auth.ok) return respond(env, request, { ok: false, error: auth.error }, auth.status);

          const body = await readJson(request);
          // Never trust client points/USD/season/identity — only tx locator from client
          const chainId = Number(body.chainId);
          const walletRow = await env.DB.prepare(
            `SELECT address FROM wallet_links WHERE identity_id = ? AND chain_id = ?`
          )
            .bind(auth.session.identityId, chainId)
            .first();
          if (!walletRow) {
            return respond(env, request, { ok: false, error: "wallet_not_linked_for_chain" }, 403);
          }
          // Default production verifier; tests inject claimVerifier via createWorker
          const v = await claimVerifier(env, body, {
            fetchImpl,
            walletAddress: walletRow.address,
          });
          if (!v.ok) {
            return respond(env, request, { ok: false, error: v.error, verification: v.verification }, v.status || 503);
          }
          // productionGrantsEnabled hard-off: verify may succeed for readiness tests, but inserts require grants OR injected test verifier flag
          if (!allowClaimInsert && env.PRODUCTION_GRANTS_ENABLED !== "1") {
            return respond(env, request, {
              ok: false,
              error: "grants_disabled",
              verifiedPreview: {
                purchaseUsd: v.purchaseUsd,
                purchaseAtMs: v.purchaseAtMs,
                purchaser: v.purchaser,
                chainId: v.chainId,
                txHash: v.txHash,
                logIndex: v.logIndex,
              },
              note: "Receipt verification implemented; ledger inserts disabled until X OAuth + owner prelaunch policy + grants flag.",
            }, 503);
          }

          const inserted = await insertVerifiedClaim(env.DB, {
            identityId: auth.session.identityId,
            chainId: v.chainId,
            txHash: v.txHash,
            logIndex: v.logIndex,
            purchaseUsd: v.purchaseUsd,
            purchaseAtMs: v.purchaseAtMs,
            receiptStatus: v.receiptStatus || "verified_dapp_abi",
          });
          if (!inserted.ok) return respond(env, request, { ok: false, error: inserted.error }, inserted.status || 409);
          return respond(env, request, { ok: true, claim: inserted.claim });
        }

        // Test-only helper retained for oauth state unit tests
        if (path === "/v1/auth/x/state/consume" && request.method === "POST") {
          const body = await readJson(request);
          const r = await consumeOAuthState(env.DB, body.state || "");
          return respond(env, request, r, r.ok ? 200 : 409);
        }

        return respond(env, request, { ok: false, error: "not_found" }, 404);
      } catch (err) {
        const status = err.status || 500;
        return respond(env, request, { ok: false, error: String(err && (err.message || err)) }, status);
      }
    },
  };
}

export default createWorker();
