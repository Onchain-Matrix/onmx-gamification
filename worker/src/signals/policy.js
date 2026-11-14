import { REFERRAL_TIERS, referralL1Points, referralL2Points } from "../../../src/referral-tiers.js";

/**
 * Matrix Signals + referral policy (Signals table: owner approved Nov 13 2026;
 * referral tiers: owner approved Nov 14 2026).
 * Mirrors SIGNALS / REFERRAL_TIERS in src/config.js. The Worker is the source of truth for granted points.
 */
export const REFERRAL_POLICY = REFERRAL_TIERS;
export { referralL1Points, referralL2Points };
export const SIGNAL_POLICY = Object.freeze({
  version: "signals-policy-v1",
  // Credits for an APPROVED signal at the "accepted" tier. strong = x2, outstanding = x4. Rejected / spam = 0.
  baseCredits: Object.freeze({ reply: 5, quote: 4, connect: 6, discover: 6, standalone: 2 }),
  tierMultiplier: Object.freeze({ accepted: 1, strong: 2, outstanding: 4 }),
  // Outcome bonuses (reviewer-confirmed only), summed then capped per signal.
  outcomeBonus: Object.freeze({ kolReplied: 5, kolFollowed: 3, directInterest: 5, introduction: 15 }),
  bonusCapPerSignal: 25,
  types: Object.freeze(["reply", "quote", "connect", "discover", "standalone"]),
  topics: Object.freeze(["rwa", "bnb", "treasury", "defi", "stablecoin", "credit", "macro", "tokenomics", "data", "other"]),
  maxSubmissionsPerDay: 5,     // per player, UTC day
  maxPendingTotal: 10,          // per player at any time
  whyMin: 10,
  whyMax: 280,
});

export function signalBaseCredits(type, tier, p = SIGNAL_POLICY) {
  const b = p.baseCredits[type];
  const m = p.tierMultiplier[tier];
  if (!b || !m) return 0;
  return b * m;
}

export function signalBonusCredits(outcomes = {}, p = SIGNAL_POLICY) {
  let s = 0;
  for (const [k, v] of Object.entries(p.outcomeBonus)) if (outcomes && outcomes[k] === true) s += v;
  return Math.min(s, p.bonusCapPerSignal);
}

const X_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com", "mobile.x.com"]);
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const RESERVED = new Set(["i", "home", "explore", "search", "settings", "intent", "share", "hashtag", "notifications", "messages"]);

export function canonHandle(raw) {
  const h = String(raw ?? "").trim().replace(/^@+/, "");
  if (!HANDLE_RE.test(h)) return null;
  return h.toLowerCase();
}

/** Parse an x.com / twitter.com status URL → { handle, statusId, url } or null. */
export function parseStatusUrl(raw) {
  let u;
  try { u = new URL(String(raw ?? "").trim()); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (!X_HOSTS.has(u.hostname.toLowerCase())) return null;
  const m = u.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{5,25})(?:\/.*)?$/);
  if (!m || RESERVED.has(m[1].toLowerCase())) return null;
  const handle = m[1].toLowerCase();
  return { handle, statusId: m[2], url: `https://x.com/${m[1]}/status/${m[2]}` };
}

/** Parse an x.com profile URL → { handle, url } or null. */
export function parseProfileUrl(raw) {
  let u;
  try { u = new URL(String(raw ?? "").trim()); } catch { return null; }
  if (!X_HOSTS.has(u.hostname.toLowerCase())) return null;
  const m = u.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
  if (!m || RESERVED.has(m[1].toLowerCase())) return null;
  return { handle: m[1].toLowerCase(), url: `https://x.com/${m[1]}` };
}

/**
 * Validate a player submission. Returns { ok, value } or { ok:false, error }.
 * Rules: signal URL must be a status URL authored by the player's handle (except Discover, where it is optional).
 * Reply / Quote / Connect need a target status URL. Discover needs a target (status or profile). Standalone: target optional.
 */
export function validateSubmission(body, playerHandle, p = SIGNAL_POLICY) {
  const type = String(body?.type || "").toLowerCase();
  if (!p.types.includes(type)) return { ok: false, error: "invalid_type" };
  const topic = String(body?.topic || "").toLowerCase();
  if (!p.topics.includes(topic)) return { ok: false, error: "invalid_topic" };
  const why = String(body?.why ?? "").trim().replace(/\s+/g, " ");
  if (why.length < p.whyMin || why.length > p.whyMax) return { ok: false, error: "invalid_why" };

  let signal = null;
  const rawSignal = String(body?.signalUrl ?? "").trim();
  if (rawSignal || type !== "discover") {
    signal = parseStatusUrl(rawSignal);
    if (!signal) return { ok: false, error: "invalid_signal_url" };
    if (signal.handle !== playerHandle) return { ok: false, error: "signal_not_by_player" };
  }

  let target = null;
  const rawTarget = String(body?.targetUrl ?? "").trim();
  if (rawTarget) {
    const st = parseStatusUrl(rawTarget);
    if (st) target = { key: st.statusId, url: st.url, handle: st.handle };
    else if (type === "discover" || type === "standalone") {
      const pr = parseProfileUrl(rawTarget);
      if (pr) target = { key: "profile:" + pr.handle, url: pr.url, handle: pr.handle };
    }
    if (!target) return { ok: false, error: "invalid_target_url" };
  } else if (type !== "standalone") {
    return { ok: false, error: "target_required" };
  }
  if (signal && target && signal.statusId === target.key) return { ok: false, error: "signal_equals_target" };
  if (target && target.handle === playerHandle && type !== "standalone") return { ok: false, error: "target_is_self" };

  return {
    ok: true,
    value: {
      type,
      topic,
      why,
      onmxMentioned: body?.onmxMentioned === true || body?.onmxMentioned === "yes",
      signalUrl: signal ? signal.url : null,
      signalKey: signal ? signal.statusId : null,
      targetUrl: target ? target.url : null,
      targetKey: target ? target.key : null,
      targetHandle: target ? target.handle : null,
    },
  };
}

/** Sanitize reviewer outcome input. */
export function cleanOutcomes(o = {}) {
  const n = (v) => { const x = Math.floor(Number(v)); return Number.isFinite(x) && x >= 0 && x < 1e10 ? x : null; };
  return {
    impressions: n(o.impressions),
    repliesGenerated: n(o.repliesGenerated),
    likes: n(o.likes),
    kolReplied: o.kolReplied === true,
    kolFollowed: o.kolFollowed === true,
    directInterest: o.directInterest === true,
    introduction: o.introduction === true,
    notes: String(o.notes ?? "").slice(0, 500),
  };
}
