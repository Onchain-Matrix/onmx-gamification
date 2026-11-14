// ONMX Gamification — PROVISIONAL CONFIG.
// EVERY value here is an ASSUMPTION / PLACEHOLDER unless marked as an owner decision.
// Edit the SEASON block below as the single source for season dates, prizes, referrals, and task points.

/** Single editable season/campaign block. Bump number/start/end for Season 2+; never retie lifetimeStart. */
export const SEASON = Object.freeze({
  number: 1,
  // Owner-approved schedule (Nov 13 2026): Wed Nov 18 noon ET → Wed Dec 9 noon ET (three weeks).
  // Explicit -05:00 (EST) so browsers in any TZ parse noon Eastern correctly.
  start: "2026-11-18T12:00:00-05:00",
  end: "2026-12-09T12:00:00-05:00",
  timeZone: "America/New_York",
  // FIXED campaign launch — both season/lifetime credit bars count from here; do not change when bumping SEASON.number.
  lifetimeStart: "2026-11-18T12:00:00-05:00",
  // Season 1 prize (owner decision Nov 13 2026). Visible copy lives in PRIZE_COPY below.
  prizes: Object.freeze({
    // Owner decision (Nov 13 2026): $600 total, paid in BNB — $300 / $200 / $100 for places 1–3.
    usdTotal: 600,
    usdSplit: Object.freeze([300, 200, 100]),
    payoutAsset: "BNB",
    // PROPOSED (not final): separate USD growth = growthPct × cumulative raised USD. Not converted to BNB here.
    growthPctOfRaisedUsd: 0.01
  }),
  // MATRIX SIGNALS player tasks (owner approved Nov 13 2026; shown publicly while PUBLIC_UI.signals is true).
  // points = scoring points for ONE approved signal at the "accepted" tier (100 points = 1 Credit).
  // Engine compatibility: an approved signal becomes a task row { type: id, effort: tierMultiplier } ⇒ points × multiplier.
  // Credits are granted only by a reviewer approving the submission in the Worker — never self-awarded.
  tasks: Object.freeze([
    Object.freeze({ id: "signal_reply", label: "Reply", points: 500,
      desc: "Read the whole thread first, then reply with a useful thought, question or second-order point in your own words. Mention @Onchain_Matrix only if it genuinely adds to the conversation." }),
    Object.freeze({ id: "signal_quote", label: "Quote post", points: 400,
      desc: "Quote a relevant post when you can add a stronger thesis for your own followers. Contribute first, mention second, never copy a script." }),
    Object.freeze({ id: "signal_connect", label: "Connect", points: 600,
      desc: "When someone is actively asking for a treasury, RWA or onchain-finance solution, partner or expert, introduce Onchain Matrix and explain briefly why it fits." }),
    Object.freeze({ id: "signal_discover", label: "Discover", points: 600,
      desc: "Report an account, protocol, partnership or industry discussion the team should approach. No public reply needed — tell us who it is and why it matters." }),
    Object.freeze({ id: "signal_standalone", label: "Standalone post", points: 200,
      desc: "Write an original post about an idea Onchain Matrix is working on, in your own words. Lower priority than joining a live conversation." })
  ]),
  // LEGACY player tasks (replaced by Matrix Signals). Kept so older fixtures/sim still score; shown on the public page
  // only while PUBLIC_UI.signals is false (so the live page does not change until the owner flips the flag).
  legacyTasks: Object.freeze([
    Object.freeze({ id: "receipt_check", label: "Receipt check", points: 10 }),
    Object.freeze({ id: "verifier_checklist", label: "Verifier checklist", points: 40 }),
    Object.freeze({ id: "architect_ship", label: "Architect ship", points: 60 }),
    Object.freeze({ id: "circle_onboard", label: "Circle onboard", points: 25 }),
    Object.freeze({ id: "video_watch", label: "Video watch (one-time)", points: 5 })
  ]),
  // Season 1 referral — SERVER-SIDE (Worker + D1), replaces the browser-local prototype. Owner approved Nov 13 2026; UI behind PUBLIC_UI.referral.
  // A referral QUALIFIES only when the referred player's FIRST Matrix Signal is APPROVED by a reviewer.
  // Then: referrer +10 Credits (level 1), referrer's referrer +5 Credits (level 2, only if that referrer is an approved contributor).
  // No self-referral; one referrer per player, set at registration and immutable; cap 20 qualified per referrer per season.
  // Referral Credits stay LIFETIME-ONLY (never season / BNB ranking) per the 6 Nov 2026 owner policy.
  referral: Object.freeze({
    enabled: true,
    enabledSeasons: Object.freeze([1]),
    model: "server-flat-v1",
    referrerCredits: 10,   // level 1
    level2Credits: 5,      // level 2
    welcomeCredits: 0,     // owner approved Nov 13 2026: level 2 (+5), no welcome bonus
    capQualifiedPerSeason: 20,
    qualifyOn: "first_approved_signal",
    campaignId: "onmx-campaign"
  }),
  // PROPOSED / PROVISIONAL treasury buy-in bonus (raw SCORING POINTS, not Credits).
  // Continuous bounded formula (no bracket cliffs): points = cap * (1 - exp(-USD / scaleUsd)),
  // then round to 2 decimals, clamp [0, cap]. Cap is per player per season.
  // Claim is frozen ONCE at purchase (see freezeTreasuryBuyClaim). Later config/fund changes do NOT retro-score.
  // Additional purchases in the same season do NOT raise the current claim — they queue for the NEXT configured season
  // as a distinct claim (new tx id). No verified purchase feed / identity linking is live yet.
  treasuryBuy: Object.freeze({
    status: "proposed", // not final owner terms
    formulaVersion: "exp-v1",
    capPoints: 250, // max raw scoring points / player / season
    scaleUsd: 1000, // adjustable; larger ⇒ slower approach to cap
    minUsd: 0, // formula defined for usd > 0; non-finite / <=0 ⇒ 0
    // INTEGRATION: ranking destination undecided — schedule + pure helpers only until verification backend exists.
  })
});

/**
 * PUBLIC UI SWITCHES — what visitors see on the live dashboard.
 * Features that are not live stay in the code but are hidden while their flag is false.
 * Flip a flag to true only with owner approval.
 */
export const PUBLIC_UI = Object.freeze({
  liveData: false,            // false ⇒ no fixture/test rows anywhere; season shown as upcoming/not launched even after the start time
  showTreasury: false,        // Treasury tab (index, buy-in scoring points) — not live
  showPrizeGrowth: false,     // 1% treasury-linked prize growth — not approved
  showReferral: false,        // LEGACY browser-local referral prototype — retired; keep false (replaced by `referral` below)
  signals: true,              // Matrix Signals tasks, submission form and Credit table — owner approved Nov 13 2026
  referral: true,             // server-side referral link / ?ref=CODE signup / pending vs qualified counts — owner approved Nov 13 2026
  showAirdropConversion: false // Credits → airdrop conversion copy — not announced
});

/**
 * MATRIX SIGNALS credit table (owner approved Nov 13 2026). Mirrors worker/src/signals/policy.js (Worker is authoritative).
 * Credits for one APPROVED signal = base[type] × tierMultiplier[tier] + capped outcome bonus. Rejected / low-quality / spam = 0.
 */
export const SIGNALS = Object.freeze({
  status: "approved", // owner approved Nov 13 2026
  policyVersion: "signals-policy-v1",
  apiBase: "https://onmx-gamification-claims.onmx.workers.dev",
  baseCredits: Object.freeze({ reply: 5, quote: 4, connect: 6, discover: 6, standalone: 2 }),
  tierMultiplier: Object.freeze({ accepted: 1, strong: 2, outstanding: 4 }),
  outcomeBonus: Object.freeze({ kolReplied: 5, kolFollowed: 3, directInterest: 5, introduction: 15 }),
  bonusCapPerSignal: 25,
  maxSubmissionsPerDay: 5,
  maxPendingTotal: 10,
  topics: Object.freeze(["rwa", "bnb", "treasury", "defi", "stablecoin", "credit", "macro", "tokenomics", "data", "other"])
});

/** Credits for one approved signal (pure). Unknown type/tier ⇒ 0. */
export function signalCredits(type, tier, outcomes = {}, sig = SIGNALS) {
  const b = sig.baseCredits[type], m = sig.tierMultiplier[tier];
  if (!b || !m) return 0;
  let bonus = 0;
  for (const [k, v] of Object.entries(sig.outcomeBonus)) if (outcomes && outcomes[k] === true) bonus += v;
  return b * m + Math.min(bonus, sig.bonusCapPerSignal);
}

/** Map an APPROVED Worker signal to an engine task row (base Credits only; bonuses/referrals are separate ledger rows). */
export function signalToTask({ account, type, tier, date, status }, sig = SIGNALS) {
  if (status !== "approved") return null;
  const m = sig.tierMultiplier[tier];
  if (!m || !sig.baseCredits[type]) return null;
  return { account, type: "signal_" + type, effort: m, date };
}

/**
 * How to Play display labels. Tile values are read from SIGNALS / SEASON at render
 * time (display only). Do not hardcode the Credit table here, and do not treat
 * this object as a second scoring source — Worker policy.js stays authoritative.
 */
export const HOW_TO_PLAY = Object.freeze({
  inviteTitle: "Invite a friend",
  tierLabels: Object.freeze({ accepted: "Accepted", strong: "Strong", outstanding: "Outstanding" }),
  outcomeLabels: Object.freeze({
    kolReplied: "KOL replied",
    kolFollowed: "KOL followed",
    directInterest: "direct interest",
    introduction: "introduction"
  })
});

/** Public prize line (owner decision Nov 13 2026). Single place to edit the visible prize copy. Never pair with a Credits→airdrop rate. */
export const PRIZE_COPY = "Season 1 prize: $600 paid in BNB — $300 / $200 / $100 for the top 3.";

/**
 * Retained season definitions for Results history + cumulative Championship.
 * SEASON above is the active/editable current season; prior seasons are appended here when closed.
 * Do not invent future seasons — only configured entries. Static Pages derives views at load time.
 * status: "upcoming" | "active" | "completed" (derived from now vs start/end at runtime if omitted).
 * results: optional retained top rows [{account, handle, score, seasonPoints}] after a season closes with real data.
 * Empty/all-zero fixtures must NOT be treated as winners (see seasonStandings).
 */
export const SEASON_HISTORY = Object.freeze([
  Object.freeze({
    number: 1,
    start: SEASON.start,
    end: SEASON.end,
    timeZone: SEASON.timeZone,
    // No retained final results yet — Season 1 has not closed; UI shows sample preview only.
    results: null
  })
]);

export function seasonStatus(def, nowMs = Date.now()) {
  const a = toInstantMs(def.start), b = toInstantMs(def.end), t = nowMs;
  if (t < a) return "upcoming";
  if (t >= b) return "completed";
  return "active";
}

/** Completed seasons only (now >= end), newest first. */
export function completedSeasons(history = SEASON_HISTORY, nowMs = Date.now()) {
  return history.filter(s => seasonStatus(s, nowMs) === "completed").sort((x, y) => y.number - x.number);
}

/**
 * Cumulative championship: SUM of retained per-season points across seasons played.
 * Skipping a season adds 0 (no penalty/decay). Referral/airdrop credits excluded.
 * Only counts seasons with real retained results (non-null, with positive seasonPoints somewhere).
 */
export function cumulativeChampionship(history = SEASON_HISTORY, nowMs = Date.now()) {
  const totals = new Map();
  for (const s of history) {
    if (seasonStatus(s, nowMs) !== "completed") continue;
    const rows = s.results;
    if (!Array.isArray(rows) || !rows.length) continue;
    if (!rows.some(r => (Number(r.seasonPoints) || 0) > 0)) continue; // ignore all-zero empty fixtures
    for (const r of rows) {
      const id = String(r.account || "");
      if (!id) continue;
      const cur = totals.get(id) || { account: id, handle: r.handle || id.replace(/^@/, ""), points: 0, seasonsPlayed: 0 };
      cur.points += Number(r.seasonPoints) || 0;
      cur.seasonsPlayed += 1;
      if (r.handle) cur.handle = r.handle;
      totals.set(id, cur);
    }
  }
  const standings = [...totals.values()].filter(r => r.points > 0).sort((a, b) => b.points - a.points || String(a.account).localeCompare(String(b.account)));
  standings.forEach((r, i) => { r.rank = i + 1; });
  return standings;
}


// Signal tasks + legacy tasks (legacy kept so old fixtures/sim still score).
const TASK_WEIGHTS = Object.freeze(Object.fromEntries([...SEASON.legacyTasks, ...SEASON.tasks].map(t => [t.id, t.points])));

export const CONFIG = Object.freeze({
  version: "provisional-0.1 (UNAPPROVED)",
  MAX_VALUE: 1e12,
  // Derived from SEASON.tasks — do not edit here; edit SEASON.tasks.
  TASK_WEIGHTS,
  ONE_TIME_TASKS: ["video_watch"],
  DECAY: { graceDays: 7, ratePerDay: 0.02 },
  SEED_BANDS: [ { minUsd: 0, mult: 1.0 }, { minUsd: 10, mult: 1.1 }, { minUsd: 1000, mult: 1.25 }, { minUsd: 10000, mult: 1.5 }, { minUsd: 100000, mult: 2.0 } ],
  // LEGACY (5 Nov brainstorm): % of referee base energy, L1 10% / L2 5%, 30/60-day gates. NOT the Season 1 model.
  // Kept only for the old engine helper referralEnergy() + sim. Season 1 uses REFERRAL_FLAT (server-side, flat Credits).
  REFERRAL: { legacy: true, levels: [0.10, 0.05] },
  REFERRAL_FLAT: { l1Credits: 10, l2Credits: 5, capQualifiedPerSeason: 20, qualifyOn: "first_approved_signal", scope: "lifetime_only" },
  GATES: [ { day: 30, share: 0.5 }, { day: 60, share: 0.5 } ],
  F1_POINTS: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1],
  // Next-round head start (raw scoring points): #1–5 +25, #6–10 +15, #11–20 +5; #21+ 0. = 0.25/0.15/0.05 Credits at 100 pts/Credit.
  HEADSTART: { placement: [25, 25, 25, 25, 25, 15, 15, 15, 15, 15, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5] },
  // Display only: 100 raw scoring points = 1 Credit. Not an airdrop/token rate. Key name kept for compatibility.
  POINTS_PER_BATTERY: 100,
  TREASURY_CURVE: { floor: 100, pct: 0.01, cap: 100000 },
  CLASSES: [ { min: 2000, name: "Architect" }, { min: 1200, name: "Node" }, { min: 600, name: "Verifier" }, { min: 1, name: "Signal" }, { min: 0, name: "Unranked" } ],
  VISIBILITY: "UNDECIDED",
  BOARD_SIZE: 100,
});

/** Parse season/task instants. Date-only YYYY-MM-DD ⇒ that calendar day at noon -05:00 (EST). */
export function toInstantMs(iso) {
  const s = String(iso ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(s + "T12:00:00-05:00");
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error("bad date: " + iso);
  return t;
}

/** Half-open window [from, to) in real milliseconds. */
export function inHalfOpenWindow(iso, from, to) {
  const t = toInstantMs(iso);
  if (from != null && from !== "" && t < toInstantMs(from)) return false;
  if (to != null && to !== "" && t >= toInstantMs(to)) return false;
  return true;
}

/**
 * PROPOSED continuous buy-in points: cap * (1 - exp(-usd/scaleUsd)), 2dp, clamped to [0, cap].
 * Never uses Seed multipliers. Not Credits (100 pts = 1 Credit only for display).
 */
export function treasuryBuyPoints(usd, season = SEASON) {
  const tb = season.treasuryBuy || {};
  const cap = Number(tb.capPoints) || 0;
  const scale = Number(tb.scaleUsd) || 0;
  const x = Number(usd);
  if (!Number.isFinite(x) || x <= 0 || !(cap > 0) || !(scale > 0)) return 0;
  const raw = cap * (1 - Math.exp(-x / scale));
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const rounded = Math.round(raw * 100) / 100;
  return Math.min(cap, Math.max(0, rounded));
}

/** Proposed prize growth in USD (not BNB): growthPct × cumulativeRaisedUsd. */
export function proposedPrizeGrowthUsd(cumulativeRaisedUsd, season = SEASON) {
  const pct = Number(season.prizes?.growthPctOfRaisedUsd) || 0;
  const raised = Number(cumulativeRaisedUsd);
  if (!Number.isFinite(raised) || raised <= 0 || pct <= 0) return 0;
  return Math.round(raised * pct * 100) / 100;
}

/**
 * Freeze a buy-in claim snapshot at purchase time (pure; no I/O).
 * pointsAtPurchase is locked; later formula/config edits must not rewrite this object.
 * Additional same-season purchases should call queueTreasuryBuyForNextSeason instead of mutating this claim.
 */
export function freezeTreasuryBuyClaim({
  seasonNumber,
  canonicalHandle,
  purchaseTxId,
  amountUsd,
  purchaseAt,
  season = SEASON
}) {
  const handle = String(canonicalHandle || "");
  const tx = String(purchaseTxId || "").trim();
  const usd = Number(amountUsd);
  if (!handle || !tx || !Number.isFinite(usd) || usd <= 0) {
    return { ok: false, error: "invalid claim fields" };
  }
  const points = treasuryBuyPoints(usd, season);
  return {
    ok: true,
    claim: Object.freeze({
      season: Number(seasonNumber),
      canonicalHandle: handle,
      purchaseTxId: tx,
      amountUsd: usd,
      formulaVersion: season.treasuryBuy?.formulaVersion || "unknown",
      pointsAtPurchase: points,
      purchaseAt: purchaseAt || null,
      status: "proposed-fixture", // not production-enforced
      scoringApplied: false // ranking integration not live
    })
  };
}

/**
 * Policy assumption (PROPOSED): a further purchase while a season claim already exists
 * does not increase that season's points; it queues a distinct claim for nextSeasonNumber.
 */
export function queueTreasuryBuyForNextSeason({
  existingClaim,
  nextSeasonNumber,
  purchaseTxId,
  amountUsd,
  purchaseAt,
  season = SEASON
}) {
  if (!existingClaim || existingClaim.purchaseTxId === String(purchaseTxId || "").trim()) {
    return { ok: false, error: "duplicate or missing prior claim" };
  }
  if (Number(nextSeasonNumber) <= Number(existingClaim.season)) {
    return { ok: false, error: "next season must be greater than current claim season" };
  }
  return freezeTreasuryBuyClaim({
    seasonNumber: nextSeasonNumber,
    canonicalHandle: existingClaim.canonicalHandle,
    purchaseTxId,
    amountUsd,
    purchaseAt,
    season
  });
}

/** Season cap check: sum of frozen pointsAtPurchase for one handle in one season, capped at capPoints. */
export function seasonBuyPointsTotal(claims, canonicalHandle, seasonNumber, season = SEASON) {
  const cap = Number(season.treasuryBuy?.capPoints) || 0;
  const h = String(canonicalHandle || "");
  const sn = Number(seasonNumber);
  let sum = 0;
  for (const c of claims || []) {
    if (!c || c.canonicalHandle !== h || Number(c.season) !== sn) continue;
    sum += Number(c.pointsAtPurchase) || 0;
  }
  return Math.min(cap, Math.round(sum * 100) / 100);
}

