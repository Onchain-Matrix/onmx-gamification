/**
 * X (Twitter) OAuth 2.0 PKCE adapter — FAIL CLOSED until product app secrets exist.
 * Does NOT use Grok Bot X connector tokens. Never logs secret values.
 */

export function xConfigStatus(env) {
  const hasId = Boolean(env.X_CLIENT_ID);
  const hasSecret = Boolean(env.X_CLIENT_SECRET);
  const hasRedirect = Boolean(env.X_REDIRECT_URI);
  const ready = hasId && hasSecret && hasRedirect;
  return {
    ready,
    enabled: false, // production login UI stays off until e2e
    missing: [
      !hasId && "X_CLIENT_ID",
      !hasSecret && "X_CLIENT_SECRET",
      !hasRedirect && "X_REDIRECT_URI",
    ].filter(Boolean),
    note: "Product X OAuth app must be configured as Worker secrets. Grok Bot X connection is unrelated and must not be reused.",
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

/** Validate OAuth state one-time use — used when/if X is configured. */
export async function consumeOAuthState(db, state) {
  const row = await db
    .prepare(`SELECT nonce, payload_json, expires_at, consumed_at FROM auth_nonces WHERE nonce = ? AND purpose = 'oauth_state'`)
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
