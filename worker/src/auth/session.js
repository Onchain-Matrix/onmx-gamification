import { randomId, sha256Hex, hmacHex, timingSafeEqual } from "../lib/crypto.js";

const COOKIE = "onmx_session";
const CSRF = "onmx_csrf";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
  const url = new URL(request.url);
  const secure = url.protocol === "https:" || url.hostname === "localhost";
  // Cross-site Pages → Worker needs SameSite=None; Secure
  return `Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

export async function createSession(env, db, identityId, request) {
  const id = randomId(24);
  const now = new Date();
  const exp = new Date(now.getTime() + SESSION_TTL_MS);
  const ua = request.headers.get("User-Agent") || "";
  await db
    .prepare(
      `INSERT INTO sessions (id, identity_id, created_at, expires_at, user_agent_hash)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(id, identityId, now.toISOString(), exp.toISOString(), await sha256Hex(ua))
    .run();
  const csrf = randomId(16);
  const sig = await hmacHex(env.SESSION_SECRET, `${id}.${csrf}`);
  const token = `${id}.${csrf}.${sig}`;
  return {
    sessionId: id,
    csrf,
    setCookies: [
      `${COOKIE}=${encodeURIComponent(token)}; ${cookieFlags(request)}`,
    ],
  };
}

export async function loadSession(env, db, request) {
  if (!env.SESSION_SECRET) return null;
  const cookies = parseCookies(request.headers.get("Cookie"));
  const raw = cookies[COOKIE];
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [id, csrf, sig] = parts;
  const expect = await hmacHex(env.SESSION_SECRET, `${id}.${csrf}`);
  if (!timingSafeEqual(sig, expect)) return null;
  const row = await db
    .prepare(
      `SELECT s.id, s.identity_id, s.expires_at, s.revoked_at
       FROM sessions s WHERE s.id = ?`
    )
    .bind(id)
    .first();
  if (!row || row.revoked_at) return null;
  if (Date.parse(row.expires_at) < Date.now()) return null;
  return { sessionId: row.id, identityId: row.identity_id, csrf };
}

export async function requireSession(env, db, request, { requireCsrf = true } = {}) {
  const sess = await loadSession(env, db, request);
  if (!sess) return { ok: false, status: 401, error: "unauthenticated" };
  if (requireCsrf && request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
    const hdr = request.headers.get("X-CSRF-Token") || "";
    if (!hdr || !timingSafeEqual(hdr, sess.csrf)) return { ok: false, status: 403, error: "csrf" };
  }
  return { ok: true, session: sess };
}

export async function createIdentity(db) {
  const id = "id_" + randomId(16);
  await db
    .prepare(`INSERT INTO identities (id, created_at) VALUES (?, ?)`)
    .bind(id, new Date().toISOString())
    .run();
  return id;
}
