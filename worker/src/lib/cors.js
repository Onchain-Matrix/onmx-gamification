const DEFAULT_ORIGIN = "https://onchain-matrix.github.io";

export function allowedOrigin(env, request) {
  const allowed = env.ALLOWED_ORIGIN || DEFAULT_ORIGIN;
  const origin = request.headers.get("Origin");
  if (!origin) return { ok: true, origin: null, allowed };
  if (origin === allowed) return { ok: true, origin, allowed };
  return { ok: false, origin, allowed };
}

export function corsHeaders(env, request) {
  const { ok, origin, allowed } = allowedOrigin(env, request);
  const h = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-CSRF-Token",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
  if (ok && origin) h["Access-Control-Allow-Origin"] = origin;
  else if (!request.headers.get("Origin")) {
    /* same-origin / no Origin — omit ACAO */
  } else {
    h["Access-Control-Allow-Origin"] = allowed; // echo only allowed; browser still blocks others
  }
  return { ok, headers: h };
}

/** Reject state-changing requests that are cross-origin without matching Origin/Referer. */
export function requireSameSiteMutation(env, request) {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return { ok: true };
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGIN || DEFAULT_ORIGIN;
  if (origin) {
    if (origin !== allowed) return { ok: false, error: "csrf_origin" };
    return { ok: true };
  }
  // No Origin: require Referer under allowed origin (browsers on credentialed XHR usually send Origin)
  const ref = request.headers.get("Referer") || "";
  if (ref.startsWith(allowed + "/") || ref === allowed) return { ok: true };
  return { ok: false, error: "csrf_referer" };
}
