/** Secure random + timing-safe helpers (Web Crypto). */
export function randomBytes(n = 32) {
  const u = new Uint8Array(n);
  crypto.getRandomValues(u);
  return u;
}

export function randomId(bytes = 16) {
  return [...randomBytes(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomNonce() {
  return randomId(24);
}

export async function sha256Hex(data) {
  const enc = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const dig = await crypto.subtle.digest("SHA-256", enc);
  return [...new Uint8Array(dig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a, b) {
  const aa = typeof a === "string" ? new TextEncoder().encode(a) : a;
  const bb = typeof b === "string" ? new TextEncoder().encode(b) : b;
  if (aa.length !== bb.length) return false;
  let out = 0;
  for (let i = 0; i < aa.length; i++) out |= aa[i] ^ bb[i];
  return out === 0;
}

/** HMAC-SHA256 hex using SESSION_SECRET (utf8). */
export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
