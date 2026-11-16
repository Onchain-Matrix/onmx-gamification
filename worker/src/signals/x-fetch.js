/**
 * Fetch X post text for AI review. Uses Worker secret X_BEARER_TOKEN (not set
 * until the owner adds it). Missing secret → { ok:false, status:"no_x_secret" }.
 * Never awards credits or changes signal status.
 */
import { parseStatusUrl } from "./policy.js";

export const X_TWEETS_BASE = "https://api.x.com/2/tweets";
export const TWEET_FIELDS = "text,created_at,author_id,conversation_id,note_tweet";

/** Normalize an x.com / twitter.com status URL and return the status id, or null. */
export function extractStatusId(rawUrl) {
  const p = parseStatusUrl(rawUrl);
  return p ? p.statusId : null;
}

/** Canonical https://x.com/<handle>/status/<id> form, or null. */
export function normalizeStatusUrl(rawUrl) {
  const p = parseStatusUrl(rawUrl);
  return p ? p.url : null;
}

export function tweetsLookupUrl(ids, apiBase = X_TWEETS_BASE) {
  const unique = [...new Set((ids || []).map((id) => String(id)).filter(Boolean))];
  const base = String(apiBase || X_TWEETS_BASE).replace(/\/+$/, "");
  const fields = encodeURIComponent(TWEET_FIELDS);
  if (unique.length === 0) return null;
  if (unique.length === 1) return `${base}/${unique[0]}?tweet.fields=${fields}`;
  return `${base}?ids=${unique.map(encodeURIComponent).join(",")}&tweet.fields=${fields}`;
}

export function postTextFromTweet(tweet) {
  if (!tweet || typeof tweet !== "object") return "";
  const note = tweet.note_tweet && typeof tweet.note_tweet === "object" ? tweet.note_tweet.text : "";
  const text = (note && String(note)) || tweet.text || "";
  return String(text);
}

function collectTweets(payload) {
  const out = {};
  if (!payload || typeof payload !== "object") return out;
  const rows = Array.isArray(payload.data) ? payload.data : payload.data ? [payload.data] : [];
  for (const t of rows) {
    if (!t || !t.id) continue;
    out[String(t.id)] = {
      id: String(t.id),
      text: postTextFromTweet(t),
      authorId: t.author_id ? String(t.author_id) : null,
      createdAt: t.created_at || null,
    };
  }
  return out;
}

/**
 * Fetch one or more posts by status URL. Returns { ok, status, posts, error? }.
 * `posts` is keyed by status id. Missing/empty bearer is a clean skip.
 */
export async function fetchXPosts(urls, { bearerToken, fetchImpl = fetch, apiBase = X_TWEETS_BASE } = {}) {
  if (!bearerToken) return { ok: false, status: "no_x_secret", posts: {} };
  const ids = [];
  const seen = new Set();
  for (const raw of urls || []) {
    const id = extractStatusId(raw);
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  if (!ids.length) return { ok: false, status: "no_text", posts: {}, error: "no_status_urls" };

  const url = tweetsLookupUrl(ids, apiBase);
  let res;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: "Bearer " + bearerToken, Accept: "application/json" },
    });
  } catch (err) {
    return { ok: false, status: "fetch_failed", posts: {}, error: String(err && (err.message || err)) };
  }
  if (!res.ok) {
    let detail = `http_${res.status}`;
    try {
      const body = await res.text();
      if (body) detail = body.slice(0, 300);
    } catch {
      /* ignore */
    }
    return { ok: false, status: "fetch_failed", posts: {}, error: detail, httpStatus: res.status };
  }
  let payload;
  try {
    payload = await res.json();
  } catch (err) {
    return { ok: false, status: "fetch_failed", posts: {}, error: "invalid_json:" + String(err && err.message) };
  }
  const posts = collectTweets(payload);
  if (!Object.keys(posts).length) return { ok: false, status: "no_text", posts, error: "empty_payload" };
  return { ok: true, status: "ok", posts };
}

/** Fetch a single status URL. */
export async function fetchXPost(url, opts = {}) {
  const r = await fetchXPosts(url ? [url] : [], opts);
  const id = extractStatusId(url);
  const post = id ? r.posts[id] : null;
  if (r.ok && post) return { ok: true, status: "ok", post, text: post.text };
  return { ok: false, status: r.status, error: r.error, httpStatus: r.httpStatus, post: post || null, text: post ? post.text : "" };
}
