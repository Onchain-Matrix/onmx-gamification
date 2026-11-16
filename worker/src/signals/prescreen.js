/**
 * Rule-based pre-screen for replies to @Onchain_Matrix posts (prescreen-v1).
 *
 * Purpose: reject only clear low-substance or copycat cases before a language
 * model scores the rest. This module is pure and deterministic: no network,
 * no model calls, and it never awards credits or changes signal status.
 *
 * Suggested signal_scores columns (Dashboard Manager owns the migration):
 *   - prescreen_version  ← ruleVersion / PRESCREEN_POLICY.version
 *   - prescreen_verdict  ← verdict ("pass" | "reject")
 *   - reject_reason      ← reason (null on pass)
 *   - cluster_id         ← clusterId from applyClusters (null if unclustered)
 *
 * The model step must only see replies whose prescreen verdict is "pass"
 * (after applyClusters, so near-duplicate reject clusters are excluded).
 *
 * clusterReplies compares every pair in the batch (O(n²)). That is fine for
 * review-queue batches of hundreds; do not run it over an unbounded history
 * in one call. Two items are linked when they are from different accounts,
 * fall within clusterWindowHours, and have the same textHash or a shingle
 * Jaccard ≥ clusterJaccard. Union-find is transitive: A~B and B~C can put
 * A and C in the same cluster even if |t(A)-t(C)| exceeds the window.
 */

const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const FNV64_MASK = 0xffffffffffffffffn;
const utf8 = new TextEncoder();

const GREETINGS = Object.freeze([
  "gm", "gn", "gmgm", "gngn", "gm gm", "gn gn",
  "hello", "hi", "hey", "yo", "sup", "hiya",
  "wagmi", "lfg", "ngmi", "hfsp",
  "good morning", "good night", "good evening", "good afternoon",
  "ser", "fren", "frens", "anon",
  "wen", "moon", "bullish", "bearish",
  "nice", "great", "awesome", "amazing", "cool", "solid", "based", "fire", "wow",
  "love this", "love it", "to the moon", "lets go", "come on",
  "well said", "so true", "big if true", "probably nothing", "few understand",
  "we are so back", "were so back",
  "thanks", "thank you", "ty", "thx", "congrats", "congratulations",
  "yes", "yeah", "yep", "yess", "yea", "this", "true", "facts",
  "good", "morning", "night", "evening", "afternoon",
]);

const BAIT_PATTERNS = Object.freeze([
  "\\bthoughts\\b",
  "\\bwen\\s+(moon|listing|binance|lambo)\\b",
  "\\bis\\s+this\\s+(legit|a\\s+scam)\\b",
  "\\bwhen\\s+(airdrop|listing)\\b",
  "\\bany\\s+updates?\\b",
  "\\bwhat\\s+do\\s+you\\s+think\\b",
  "\\bany\\s+thoughts\\b",
  "\\bwen\\s+moon\\b",
  "\\bis\\s+this\\s+real\\b",
]);

const INJECTION_PATTERNS = Object.freeze([
  "ignore\\s+(all|previous|prior)\\s+instructions",
  "score\\s+(this|me)\\s+100",
  "you\\s+are\\s+(an?|the)\\s+(ai|model|grader)",
  "system\\s+prompt",
  "approve\\s+this",
]);

const STOPWORDS = Object.freeze([
  "about", "after", "also", "and", "any", "are", "been", "before", "but",
  "can", "could", "does", "for", "from", "have", "into", "just", "like",
  "more", "most", "not", "only", "our", "out", "over", "really", "should",
  "some", "than", "that", "the", "their", "them", "then", "there", "these",
  "they", "this", "those", "too", "very", "was", "were", "what", "when",
  "where", "which", "who", "why", "will", "with", "would", "you", "your",
]);

export const PRESCREEN_POLICY = Object.freeze({
  version: "prescreen-v1",
  minWords: 6,
  copyPasteJaccard: 0.8,
  clusterJaccard: 0.8,
  clusterWindowHours: 72,
  clusterRejectAccounts: 3,
  clusterBlockAccounts: 2,
  shingle: 5,
  greetings: GREETINGS,
  baitPatterns: BAIT_PATTERNS,
  injectionPatterns: INJECTION_PATTERNS,
});

const GREETING_WORDS = new Set(
  GREETINGS.flatMap((g) => normalize(g).split(/\s+/).filter(Boolean)),
);
const STOPWORD_SET = new Set(STOPWORDS);
const BAIT_RE = BAIT_PATTERNS.map((p) => new RegExp(p, "i"));
const INJECTION_RE = INJECTION_PATTERNS.map((p) => new RegExp(p, "i"));

/** FNV-1a 64-bit, lowercase 16-char hex. Hashes the string as UTF-8 bytes (no normalize). */
export function fnv1a64Hex(text) {
  const bytes = utf8.encode(String(text ?? ""));
  let hash = FNV64_OFFSET;
  for (const b of bytes) {
    hash ^= BigInt(b);
    hash = (hash * FNV64_PRIME) & FNV64_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Lowercase; strip @mentions, URLs, and emoji/pictographs (Extended_Pictographic,
 * variation selectors, ZWJ); keep $cashtag words; turn punctuation into spaces;
 * collapse whitespace. Apostrophes inside words are dropped so "let's" → "lets".
 */
export function normalize(text) {
  let s = String(text ?? "").toLowerCase();
  s = s.replace(/https?:\/\/[^\s]+/g, " ");
  s = s.replace(/\bwww\.[^\s]+/g, " ");
  s = s.replace(/@[a-z0-9_]{1,15}/g, " ");
  s = s.replace(/\$([a-z][a-z0-9]*)/g, "$1");
  s = s.replace(/\p{Extended_Pictographic}/gu, " ");
  s = s.replace(/[\u200D\uFE0E\uFE0F]/g, " ");
  s = s.replace(/(\p{L})['’](\p{L})/gu, "$1$2");
  s = s.replace(/[^\p{L}\p{N}]+/gu, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

export function words(text) {
  const s = normalize(text);
  return s ? s.split(" ") : [];
}

/**
 * Word n-grams of normalized text. If the text has fewer than n words, falls
 * back to a single shingle of the whole text (or [] if empty).
 */
export function shingles(text, n = PRESCREEN_POLICY.shingle) {
  const w = words(text);
  const size = Math.min(Math.max(1, n), w.length);
  if (w.length === 0) return [];
  if (w.length <= size) return [w.join(" ")];
  const out = [];
  for (let i = 0; i <= w.length - size; i++) out.push(w.slice(i, i + size).join(" "));
  return out;
}

/** Jaccard similarity of two shingle (or token) lists. Empty vs empty is 0. */
export function jaccard(a, b) {
  const A = a instanceof Set ? a : new Set(a ?? []);
  const B = b instanceof Set ? b : new Set(b ?? []);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Deterministic FNV-1a 64 hex of normalize(text). */
export function textHash(text) {
  return fnv1a64Hex(normalize(text));
}

function containsEmoji(text) {
  return /\p{Extended_Pictographic}/u.test(String(text ?? ""));
}

function contentWords(text) {
  return words(text).filter((w) => w.length >= 4 && !STOPWORD_SET.has(w));
}

function sharedContentWordCount(a, b) {
  const B = new Set(contentWords(b));
  if (B.size === 0) return 0;
  let n = 0;
  const seen = new Set();
  for (const w of contentWords(a)) {
    if (B.has(w) && !seen.has(w)) {
      seen.add(w);
      n++;
    }
  }
  return n;
}

function isCopyPaste(replyNorm, replyShingles, wordCount, otherText, threshold) {
  if (!otherText) return false;
  const otherNorm = normalize(otherText);
  if (!otherNorm) return false;
  if (jaccard(replyShingles, shingles(otherText)) >= threshold) return true;
  if (wordCount >= PRESCREEN_POLICY.minWords && otherNorm.includes(replyNorm)) return true;
  return false;
}

function matchesAny(res, text) {
  return res.some((re) => re.test(text));
}

/**
 * @param {{ replyText: string, targetText?: string, templates?: string[] }} input
 * @returns {{ verdict: "pass"|"reject", reason: string|null, textHash: string, normalized: string, wordCount: number, ruleVersion: string }}
 *
 * Check order: empty, emoji_only, greeting_only, injection, copy_paste,
 * bait_no_substance, too_short. Anything that is not a clear reject passes.
 */
export function prescreenReply({ replyText, targetText = "", templates = [] } = {}) {
  const raw = replyText == null ? "" : String(replyText);
  const normalized = normalize(raw);
  const wordList = normalized ? normalized.split(" ") : [];
  const wordCount = wordList.length;
  const hash = fnv1a64Hex(normalized);
  const base = { textHash: hash, normalized, wordCount, ruleVersion: PRESCREEN_POLICY.version };
  const reject = (reason) => ({ verdict: "reject", reason, ...base });
  const pass = () => ({ verdict: "pass", reason: null, ...base });

  if (raw.trim() === "") return reject("empty");
  if (!normalized) {
    if (containsEmoji(raw)) return reject("emoji_only");
    return reject("too_short");
  }
  if (wordList.every((w) => GREETING_WORDS.has(w))) return reject("greeting_only");

  const scan = `${raw.toLowerCase()} ${normalized}`;
  if (matchesAny(INJECTION_RE, scan)) return reject("injection");

  const replyShingles = shingles(raw);
  if (isCopyPaste(normalized, replyShingles, wordCount, targetText, PRESCREEN_POLICY.copyPasteJaccard)) {
    return reject("copy_paste");
  }
  for (const t of templates ?? []) {
    if (isCopyPaste(normalized, replyShingles, wordCount, t, PRESCREEN_POLICY.copyPasteJaccard)) {
      return reject("copy_paste");
    }
  }

  if (
    wordCount < 12 &&
    matchesAny(BAIT_RE, normalized) &&
    sharedContentWordCount(raw, targetText) === 0
  ) {
    return reject("bait_no_substance");
  }

  if (wordCount < PRESCREEN_POLICY.minWords) return reject("too_short");
  return pass();
}

function find(parent, i) {
  let r = i;
  while (parent[r] !== r) r = parent[r];
  let x = i;
  while (parent[x] !== r) {
    const n = parent[x];
    parent[x] = r;
    x = n;
  }
  return r;
}

function union(parent, i, j) {
  const a = find(parent, i);
  const b = find(parent, j);
  if (a !== b) parent[b] = a;
}

/**
 * Cluster near-duplicate replies from different accounts in a time window.
 * Pairwise O(n²). Returns only clusters with ≥ 2 distinct accounts.
 * action is "reject" when accountCount ≥ clusterRejectAccounts (3),
 * otherwise "block_auto_approve" (accountCount ≥ clusterBlockAccounts).
 *
 * @param {{ id: string, accountId: string, text: string, createdAt: string }[]} items
 * @param {object} [opts]  overrides for window / Jaccard / thresholds
 */
export function clusterReplies(items = [], opts = {}) {
  const windowHours = opts.clusterWindowHours ?? PRESCREEN_POLICY.clusterWindowHours;
  const jacThresh = opts.clusterJaccard ?? PRESCREEN_POLICY.clusterJaccard;
  const shingleN = opts.shingle ?? PRESCREEN_POLICY.shingle;
  const rejectAt = opts.clusterRejectAccounts ?? PRESCREEN_POLICY.clusterRejectAccounts;
  const blockAt = opts.clusterBlockAccounts ?? PRESCREEN_POLICY.clusterBlockAccounts;
  const windowMs = windowHours * 3600 * 1000;
  const list = Array.isArray(items) ? items : [];
  const n = list.length;
  const meta = list.map((it) => ({
    id: String(it.id),
    accountId: String(it.accountId),
    createdAt: Date.parse(it.createdAt),
    hash: textHash(it.text),
    shingles: shingles(it.text, shingleN),
  }));
  const parent = Array.from({ length: n }, (_, i) => i);

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (meta[i].accountId === meta[j].accountId) continue;
      if (!Number.isFinite(meta[i].createdAt) || !Number.isFinite(meta[j].createdAt)) continue;
      if (Math.abs(meta[i].createdAt - meta[j].createdAt) > windowMs) continue;
      const similar =
        meta[i].hash === meta[j].hash ||
        jaccard(meta[i].shingles, meta[j].shingles) >= jacThresh;
      if (similar) union(parent, i, j);
    }
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(parent, i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }

  const clusters = [];
  for (const idxs of groups.values()) {
    const accounts = new Set(idxs.map((i) => meta[i].accountId));
    if (accounts.size < blockAt) continue;
    const memberIds = idxs.map((i) => meta[i].id).sort();
    const clusterId = "c_" + fnv1a64Hex(memberIds.join(","));
    const accountCount = accounts.size;
    const action = accountCount >= rejectAt ? "reject" : "block_auto_approve";
    clusters.push({ clusterId, memberIds, accountCount, action });
  }
  clusters.sort((a, b) => (a.clusterId < b.clusterId ? -1 : a.clusterId > b.clusterId ? 1 : 0));
  return clusters;
}

/**
 * Overlay cluster decisions onto prescreen results keyed by reply id.
 * Reject clusters get verdict "reject" and reason "near_duplicate".
 * Every cluster member gets clusterId, clusterSize, and autoApproveBlocked.
 * Accepts a Map or a plain object; returns the same shape (new copy).
 *
 * @param {Map<string, object>|Record<string, object>} prescreenResultsById
 * @param {{ clusterId: string, memberIds: string[], action: string }[]} clusters
 */
export function applyClusters(prescreenResultsById, clusters = []) {
  const asMap = prescreenResultsById instanceof Map;
  const out = new Map();
  const entries = asMap
    ? prescreenResultsById.entries()
    : Object.entries(prescreenResultsById ?? {});
  for (const [id, r] of entries) out.set(String(id), { ...(r ?? {}) });

  for (const c of clusters ?? []) {
    const memberIds = c.memberIds ?? [];
    const size = memberIds.length;
    const reject = c.action === "reject";
    for (const id of memberIds) {
      const key = String(id);
      const prev = out.get(key) ?? {};
      const next = {
        ...prev,
        clusterId: c.clusterId,
        clusterSize: size,
        autoApproveBlocked: true,
      };
      if (reject) {
        next.verdict = "reject";
        next.reason = "near_duplicate";
      }
      out.set(key, next);
    }
  }

  if (asMap) return out;
  const obj = {};
  for (const [k, v] of out) obj[k] = v;
  return obj;
}
