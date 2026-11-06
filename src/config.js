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
    bnbTotal: 1,
    usdIllustrativeSplit: Object.freeze([300, 200, 100]), // places 1–3
    usdIllustrativeBand: Object.freeze([600, 700]) // illustrative total USD band for the 1 BNB pool
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
  })
});

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
