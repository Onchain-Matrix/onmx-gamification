/**
 * Product X (Twitter) OAuth 2.0 Authorization Code + PKCE.
 * Does NOT use Grok Bot X connector tokens. Never logs secret/token values.
 *
 * Endpoints (official):
 *   authorize: https://twitter.com/i/oauth2/authorize
 *   token:     https://api.twitter.com/2/oauth2/token
 *   me:        https://api.twitter.com/2/users/me
 *
 * Injectable `fetchImpl` / `endpoints` for isolated fake-provider tests.
 */
import { randomId, sha256Hex, randomBytes } from "../lib/crypto.js";

const DEFAULT_ENDPOINTS = Object.freeze({
  authorize: "https://twitter.com/i/oauth2/authorize",
  token: "https://api.twitter.com/2/oauth2/token",
  me: "https://api.twitter.com/2/users/me",
});

const SCOPES = "users.read tweet.read offline.access";

function b64url(bytes) {
  let s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function createPkcePair() {
  const verifier = b64url(randomBytes(32));
  const enc = new TextEncoder().encode(verifier);
  const dig = await crypto.subtle.digest("SHA-256", enc);
  const challenge = b64url(new Uint8Array(dig));
  return { verifier, challenge, method: "S256" };
}

export function xConfigStatus(env) {
  const hasId = Boolean(env.X_CLIENT_ID);
  const hasSecret = Boolean(env.X_CLIENT_SECRET);
  const hasRedirect = Boolean(env.X_REDIRECT_URI);
  const ready = hasId && hasSecret && hasRedirect;
  return {
    ready,
    // Login UI only when secrets present — code path is fully implemented either way
    enabled: ready,
    missing: [
      !hasId && "X_CLIENT_ID",
      !hasSecret && "X_CLIENT_SECRET",
      !hasRedirect && "X_REDIRECT_URI",
    ].filter(Boolean),
    callbackUrl: "https://onmx-gamification-claims.onmx.workers.dev/v1/auth/x/callback",
    note: "Product X OAuth app secrets required as Worker secrets. Grok Bot X connection is unrelated and must not be reused.",
  };
}

export function beginXLoginBlocked(env) {
  const st = xConfigStatus(env);
  return {
    status: 503,
    body: {
      ok: false,
      error: "x_oauth_not_configured",
      x: st,
    },
  };
}

/** Persist OAuth state (one-time). */
export async function storeOAuthState(db, { state, codeVerifier, openerOrigin, identityId = null }) {
  const now = new Date();
  const exp = new Date(now.getTime() + 10 * 60 * 1000);
  const verifierHash = await sha256Hex(codeVerifier);
  await db
    .prepare(
      `INSERT INTO auth_nonces (nonce, purpose, identity_id, payload_json, created_at, expires_at)
       VALUES (?, 'oauth_state', ?, ?, ?, ?)`
    )
    .bind(
      state,
      identityId,
      JSON.stringify({
        verifierHash,
        codeVerifier, // server-side only; never returned to client logs
        openerOrigin,
        pkce: true,
      }),
      now.toISOString(),
      exp.toISOString()
    )
    .run();
}

export async function consumeOAuthState(db, state) {
  const row = await db
    .prepare(
      `SELECT nonce, payload_json, expires_at, consumed_at FROM auth_nonces WHERE nonce = ? AND purpose = 'oauth_state'`
    )
    .bind(state)
    .first();
  if (!row) return { ok: false, error: "state_unknown" };
  if (row.consumed_at) return { ok: false, error: "state_replay" };
  if (Date.parse(row.expires_at) < Date.now()) return { ok: false, error: "state_expired" };
  const upd = await db
    .prepare(`UPDATE auth_nonces SET consumed_at = ? WHERE nonce = ? AND consumed_at IS NULL`)
    .bind(new Date().toISOString(), state)
    .run();
  if (!upd.meta?.changes) return { ok: false, error: "state_replay" };
  return { ok: true, payload: JSON.parse(row.payload_json) };
}

/**
 * Start OAuth — returns authorize URL. Fail-closed if secrets missing.
 */
export async function startXOAuth(env, db, { openerOrigin, identityId = null, endpoints = DEFAULT_ENDPOINTS } = {}) {
  const st = xConfigStatus(env);
  if (!st.ready) return beginXLoginBlocked(env);

  const allowed = env.ALLOWED_ORIGIN || "https://onchain-matrix.github.io";
  if (!openerOrigin || openerOrigin !== allowed) {
    return { status: 403, body: { ok: false, error: "opener_origin_forbidden" } };
  }

  const { verifier, challenge, method } = await createPkcePair();
  const state = randomId(24);
  await storeOAuthState(db, { state, codeVerifier: verifier, openerOrigin, identityId });

  const redirectUri = env.X_REDIRECT_URI;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.X_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: method,
  });
  const authorizeUrl = `${endpoints.authorize}?${params.toString()}`;
  return {
    status: 200,
    body: {
      ok: true,
      authorizeUrl,
      state,
      // PKCE verifier stays server-side; popup uses state only
      note: "Open authorizeUrl in a popup. Callback will postMessage a one-time handoff to opener_origin.",
    },
  };
}

async function basicAuthHeader(clientId, clientSecret) {
  const raw = `${clientId}:${clientSecret}`;
  const b64 = btoa(raw);
  return `Basic ${b64}`;
}

/**
 * Exchange authorization code + verify stable user id.
 * `fetchImpl` injectable for fake provider tests.
 */
export async function exchangeXCode(env, {
  code,
  codeVerifier,
  fetchImpl = fetch,
  endpoints = DEFAULT_ENDPOINTS,
}) {
  const st = xConfigStatus(env);
  if (!st.ready) return { ok: false, error: "x_oauth_not_configured" };

  const body = new URLSearchParams({
    code,
    grant_type: "authorization_code",
    client_id: env.X_CLIENT_ID,
    redirect_uri: env.X_REDIRECT_URI,
    code_verifier: codeVerifier,
  });

  const tokenRes = await fetchImpl(endpoints.token, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: await basicAuthHeader(env.X_CLIENT_ID, env.X_CLIENT_SECRET),
    },
    body,
  });
  if (!tokenRes.ok) {
    return { ok: false, error: "token_exchange_failed", status: 401 };
  }
  const tokenJson = await tokenRes.json();
  const accessToken = tokenJson.access_token;
  if (!accessToken || typeof accessToken !== "string") {
    return { ok: false, error: "token_missing" };
  }

  const meRes = await fetchImpl(`${endpoints.me}?user.fields=id,username`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!meRes.ok) return { ok: false, error: "userinfo_failed", status: 401 };
  const me = await meRes.json();
  const xUserId = String(me?.data?.id || "");
  const username = me?.data?.username ? String(me.data.username) : null;
  if (!/^\d+$/.test(xUserId)) return { ok: false, error: "invalid_x_user_id" };

  // Do not return access/refresh tokens to callers of this helper's public surface
  return { ok: true, xUserId, username };
}

/**
 * Complete callback after browser redirect: consume state, exchange, return verified X id.
 * Rejects wrong redirect binding via stored verifier / state.
 */
export async function completeXCallback(env, db, {
  code,
  state,
  fetchImpl = fetch,
  endpoints = DEFAULT_ENDPOINTS,
}) {
  if (!code || !state) return { ok: false, error: "missing_code_or_state", status: 400 };
  const st = xConfigStatus(env);
  if (!st.ready) return { ok: false, error: "x_oauth_not_configured", status: 503 };

  const consumed = await consumeOAuthState(db, state);
  if (!consumed.ok) return { ok: false, error: consumed.error, status: 409 };

  const { codeVerifier, openerOrigin } = consumed.payload || {};
  if (!codeVerifier || !openerOrigin) return { ok: false, error: "state_payload_invalid", status: 400 };

  const exchanged = await exchangeXCode(env, { code, codeVerifier, fetchImpl, endpoints });
  if (!exchanged.ok) return { ok: false, error: exchanged.error, status: exchanged.status || 401 };

  return {
    ok: true,
    xUserId: exchanged.xUserId,
    username: exchanged.username,
    openerOrigin,
  };
}

export { DEFAULT_ENDPOINTS, SCOPES };
