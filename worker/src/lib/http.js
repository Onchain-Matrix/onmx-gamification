export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

export function withCors(env, request, response) {
  const { headers } = (awaitable => awaitable) && (() => {
    // sync import pattern
  })();
  // reimplemented below in index — helper:
  return response;
}

export async function readJson(request, maxBytes = 64_000) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > maxBytes) throw Object.assign(new Error("body_too_large"), { status: 413 });
  const text = await request.text();
  if (text.length > maxBytes) throw Object.assign(new Error("body_too_large"), { status: 413 });
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}
