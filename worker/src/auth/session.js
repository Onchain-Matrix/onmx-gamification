import { randomId, sha256Hex, hmacHex, timingSafeEqual } from "../lib/crypto.js";

const COOKIE = "onmx_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HANDOFF_TTL_MS = 2 * 60 * 1000;

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieFlags(request) {
  return `Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

async function mintToken(env, id, csrf) {
  const sig = await hmacHex(env.SESSION_SECRET, `${id}.${csrf}`);
  return `${id}.${csrf}.${sig}`;
}

async function parseAndVerifyToken(env, raw) {
  if (!raw || !env.SESSION_SECRET) return null;
  const parts = String(raw).split(".");
  if (parts.length !== 3) return null;
  const [id, csrf, sig] = parts;
  const expect = await hmacHex(env.SESSION_SECRET, `${id}.${csrf}`);
  if (!timingSafeEqual(sig, expect)) return null;
  return { id, csrf };
}

/**
 * Create session. Always returns bearer accessToken in body-ready fields.
 * Optionally also sets SameSite=None cookie (unreliable cross-site; bearer is primary for Pages).
 */
export async function createSession(env, db, identityId, request, { setCookie = true } = {}) {
  const id = randomId(24);
  const now = new Date();
  const exp = new Date(now.getTime() + SESSION_TTL_MS);
  const ua = request.headers.get("User-Agent") || "";
  const csrf = randomId(16);
  const token = await mintToken(env, id, csrf);
  const bearerHash = await sha256Hex(token);

  await db
    .prepare(
      `INSERT INTO sessions (id, identity_id, created_at, expires_at, user_agent_hash, bearer_hash)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(id, identityId, now.toISOString(), exp.toISOString(), await sha256Hex(ua), bearerHash)
    .run();

  const out = {
    sessionId: id,
    csrf,
    accessToken: token, // JS memory only on client — never localStorage
    setCookies: setCookie ? [`${COOKIE}=${encodeURIComponent(token)}; ${cookieFlags(request)}`] : [],
  };
  return out;
}

async function loadSessionRow(db, id) {
  return db
    .prepare(
      `SELECT s.id, s.identity_id, s.expires_at, s.revoked_at, s.bearer_hash
       FROM sessions s WHERE s.id = ?`
    )
    .bind(id)
    .first();
}

export async function loadSession(env, db, request) {
  if (!env.SESSION_SECRET) return null;

  // Prefer Authorization Bearer (cookieless Pages mode)
  const auth = request.headers.get("Authorization") || "";
  let raw = null;
  if (/^Bearer\s+/i.test(auth)) {
    raw = auth.replace(/^Bearer\s+/i, "").trim();
  } else {
    const cookies = parseCookies(request.headers.get("Cookie"));
    raw = cookies[COOKIE] || null;
  }
  if (!raw) return null;

  const parsed = await parseAndVerifyToken(env, raw);
  if (!parsed) return null;
  const row = await loadSessionRow(db, parsed.id);
  if (!row || row.revoked_at) return null;
  if (Date.parse(row.expires_at) < Date.now()) return null;

  // Optional: confirm bearer_hash matches if present
  if (row.bearer_hash) {
    const h = await sha256Hex(raw);
    if (!timingSafeEqual(h, row.bearer_hash)) return null;
  }

  return {
    sessionId: row.id,
    identityId: row.identity_id,
    csrf: parsed.csrf,
    via: /^Bearer\s+/i.test(auth) ? "bearer" : "cookie",
  };
}

export async function requireSession(env, db, request, { requireCsrf = true } = {}) {
  const sess = await loadSession(env, db, request);
  if (!sess) return { ok: false, status: 401, error: "unauthenticated" };
  if (requireCsrf && request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
    const hdr = request.headers.get("X-CSRF-Token") || "";
    // Bearer mode: CSRF still required for mutations (token bound to session)
    if (!hdr || !timingSafeEqual(hdr, sess.csrf)) return { ok: false, status: 403, error: "csrf" };
  }
  return { ok: true, session: sess };
}

export async function createIdentity(db) {
  const id = "id_" + randomId(16);
  await db.prepare(`INSERT INTO identities (id, created_at) VALUES (?, ?)`).bind(id, new Date().toISOString()).run();
  return id;
}

/** One-time handoff after OAuth popup — exchanged for bearer token in response body. */
export async function createHandoff(db, { sessionId, identityId, csrf, openerOrigin }) {
  const code = randomId(24);
  const now = new Date();
  await db
    .prepare(
      `INSERT INTO auth_handoffs (code, session_id, identity_id, csrf, opener_origin, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      code,
      sessionId,
      identityId,
      csrf,
      openerOrigin,
      now.toISOString(),
      new Date(now.getTime() + HANDOFF_TTL_MS).toISOString()
    )
    .run();
  return code;
}

export async function consumeHandoff(env, db, { code, openerOrigin }) {
  const row = await db
    .prepare(
      `SELECT * FROM auth_handoffs WHERE code = ?`
    )
    .bind(code)
    .first();
  if (!row) return { ok: false, error: "handoff_unknown", status: 404 };
  if (row.consumed_at) return { ok: false, error: "handoff_replay", status: 409 };
  if (Date.parse(row.expires_at) < Date.now()) return { ok: false, error: "handoff_expired", status: 400 };
  if (openerOrigin && row.opener_origin !== openerOrigin) {
    return { ok: false, error: "handoff_origin_mismatch", status: 403 };
  }
  const upd = await db
    .prepare(`UPDATE auth_handoffs SET consumed_at = ? WHERE code = ? AND consumed_at IS NULL`)
    .bind(new Date().toISOString(), code)
    .run();
  if (!upd.meta?.changes) return { ok: false, error: "handoff_replay", status: 409 };

  const token = await mintToken(env, row.session_id, row.csrf);
  return {
    ok: true,
    accessToken: token,
    csrf: row.csrf,
    identityId: row.identity_id,
    sessionId: row.session_id,
  };
}

/** HTML for OAuth popup: postMessage handoff to opener with exact origin check. */
export function handoffPostMessageHtml({ openerOrigin, handoffCode, error = null }) {
  const payload = error
    ? { type: "onmx-oauth", ok: false, error }
    : { type: "onmx-oauth", ok: true, handoffCode };
  const originJson = JSON.stringify(openerOrigin || "");
  const payloadJson = JSON.stringify(payload);
  return `<!doctype html><meta charset="utf-8"><title>ONMX OAuth</title>
<script>
(function(){
  var origin = ${originJson};
  var payload = ${payloadJson};
  try {
    if (window.opener && origin) {
      window.opener.postMessage(payload, origin);
    }
  } catch (e) {}
  setTimeout(function(){ window.close(); }, 50);
})();
</script>
<p>You can close this window.</p>`;
}
