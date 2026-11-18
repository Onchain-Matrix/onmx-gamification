/**
 * /referral/<handle> share links (owner approved Nov 18 2026).
 *
 * Handoff: the dashboard (onchain-matrix.github.io) and this Worker (workers.dev) are different sites, so a cookie set here
 * can't be read by the page and is not sent on the page's cross-site API calls. The redirect therefore carries a signed,
 * expiring referral token (rt) plus the plain ref code; the page stores the token for 30 days and sends it at join.
 * The Worker ALSO sets its own 30-day HttpOnly cookie with the same token and accepts it at join when a browser sends it
 * (same-site requests only). Either way, the Worker validates the HMAC and expiry server-side; an expired or missing token
 * means no referral (no retroactive claims).
 */
import { hmacHex, timingSafeEqual } from "../lib/crypto.js";
import { canonHandle } from "./policy.js";
import { REFERRAL_POLICY } from "./policy.js";

export const REF_COOKIE = "onmx_ref";
export const DEFAULT_JOIN_URL = "https://onchain-matrix.github.io/onmx-gamification/";
const TOKEN_RE = /^v1\.([A-Z0-9]{4,16})\.(\d{9,11})\.([0-9a-f]{32})$/;

function linkTtlSeconds() {
  return REFERRAL_POLICY.linkDays * 86400;
}

async function sig(env, code, exp) {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET missing");
  return (await hmacHex(env.SESSION_SECRET, `onmx-ref:v1:${code}:${exp}`)).slice(0, 32);
}

export async function signRefToken(env, code, nowMs = Date.now()) {
  const exp = Math.floor(nowMs / 1000) + linkTtlSeconds();
  return { token: `v1.${code}.${exp}.${await sig(env, code, exp)}`, exp };
}

/** → { ok: true, code, exp } or { ok: false, error: "invalid_ref_token" | "ref_token_expired" } */
export async function verifyRefToken(env, token, nowMs = Date.now()) {
  const m = TOKEN_RE.exec(String(token || ""));
  if (!m) return { ok: false, error: "invalid_ref_token" };
  const [, code, expS, mac] = m;
  const exp = Number(expS);
  if (!timingSafeEqual(mac, await sig(env, code, exp))) return { ok: false, error: "invalid_ref_token" };
  if (Math.floor(nowMs / 1000) >= exp) return { ok: false, error: "ref_token_expired" };
  return { ok: true, code, exp };
}

export function readCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

function joinUrl(env) {
  const u = String(env.JOIN_URL || DEFAULT_JOIN_URL);
  return /^https:\/\//.test(u) ? u : DEFAULT_JOIN_URL;
}

/** GET/HEAD /referral/<handle> → 302 to the join page. Known handle: signed token in the URL + 30-day cookie. */
export async function handleReferralRedirect(env, request, slug) {
  let decoded = "";
  try { decoded = decodeURIComponent(String(slug || "")); } catch { decoded = ""; }
  const handle = canonHandle(decoded);
  const target = new URL(joinUrl(env));
  const headers = new Headers({ "cache-control": "no-store", "referrer-policy": "no-referrer" });
  if (handle) {
    const row = await env.DB.prepare(`SELECT ref_code FROM signal_players WHERE handle = ?`).bind(handle).first();
    if (row && row.ref_code) {
      const { token } = await signRefToken(env, row.ref_code);
      target.searchParams.set("ref", row.ref_code);
      target.searchParams.set("rt", token);
      headers.append("Set-Cookie", `${REF_COOKIE}=${token}; Max-Age=${linkTtlSeconds()}; Path=/; Secure; HttpOnly; SameSite=Lax`);
    }
  }
  target.hash = "signalsPanel";
  headers.set("Location", target.toString());
  return new Response(null, { status: 302, headers });
}
