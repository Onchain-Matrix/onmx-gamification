// ONMX Gamification — PROVISIONAL CONFIG.
// EVERY value here is an ASSUMPTION / PLACEHOLDER unless marked as an owner decision.
// Edit the SEASON block below as the single source for season dates, prizes, referrals, and task points.

/** Single editable season/campaign block. Bump number/start/end for Season 2+; never retie lifetimeStart. */
export const SEASON = Object.freeze({
  number: 1,
  // Explicit -05:00 (EST) so browsers in any TZ parse noon Eastern correctly.
  start: "2026-11-09T12:00:00-05:00",
  end: "2026-11-23T12:00:00-05:00",
  timeZone: "America/New_York",
  // FIXED campaign launch — both season/lifetime credit bars count from here; do not change when bumping SEASON.number.
  lifetimeStart: "2026-11-09T12:00:00-05:00",
  // Owner-configured Season 1 prize: 1 BNB total. USD figures are illustrative only (not a funding verification).
  prizes: Object.freeze({
    bnbTotal: 1, // owner base display (BNB) — not auto-mixed with USD growth
    usdIllustrativeSplit: Object.freeze([300, 200, 100]), // places 1–3 illustrative USD for the base 1 BNB
    usdIllustrativeBand: Object.freeze([600, 700]),
    // PROPOSED (not final): separate USD growth = growthPct × cumulative raised USD. Not converted to BNB here.
    growthPctOfRaisedUsd: 0.01
  }),
  // Scoring points per effort unit (effort=1 on a verified task ⇒ these points). Not Credits / not airdrop rates.
  tasks: Object.freeze([
    Object.freeze({ id: "receipt_check", label: "Receipt check", points: 10 }),
    Object.freeze({ id: "verifier_checklist", label: "Verifier checklist", points: 40 }),
    Object.freeze({ id: "architect_ship", label: "Architect ship", points: 60 }),
    Object.freeze({ id: "circle_onboard", label: "Circle onboard", points: 25 }),
    Object.freeze({ id: "video_watch", label: "Video watch (one-time)", points: 5 })
  ]),
  // Season 1 referral PROTOTYPE (browser-local). Season 2: toggle enabled / enabledSeasons / amounts.
  referral: Object.freeze({
    enabled: true,
    enabledSeasons: Object.freeze([1]),
    referrerCredits: 10, // Credits (display); lifetime-only
    welcomeCredits: 5,
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


const TASK_WEIGHTS = Object.freeze(Object.fromEntries(SEASON.tasks.map(t => [t.id, t.points])));

export const CONFIG = Object.freeze({
  version: "provisional-0.1 (UNAPPROVED)",
  MAX_VALUE: 1e12,
  // Derived from SEASON.tasks — do not edit here; edit SEASON.tasks.
  TASK_WEIGHTS,
  ONE_TIME_TASKS: ["video_watch"],
  DECAY: { graceDays: 7, ratePerDay: 0.02 },
  SEED_BANDS: [ { minUsd: 0, mult: 1.0 }, { minUsd: 10, mult: 1.1 }, { minUsd: 1000, mult: 1.25 }, { minUsd: 10000, mult: 1.5 }, { minUsd: 100000, mult: 2.0 } ],
  REFERRAL: { levels: [0.10, 0.05] },
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

