// ONMX Gamification — PROVISIONAL CONFIG.
// EVERY value here is an ASSUMPTION / PLACEHOLDER, NOT an approved owner decision.
// Source of ideas: Notion "Gamification brainstorm v1" + "leaderboard dashboard sketch v1"
// (both Pending review, brainstorm explicitly says "no formulas decided").
// No real money, token conversion, or public reward commitment is implied by any number.
export const CONFIG = Object.freeze({
  version: "provisional-0.1 (UNAPPROVED)",
  // ASSUMPTION: hard numeric ceiling for any score/energy value (overflow guard).
  MAX_VALUE: 1e12,
  // ASSUMPTION: energy per effort unit by task type. effort <= 0 => 0 energy.
  TASK_WEIGHTS: { receipt_check: 10, verifier_checklist: 40, architect_ship: 60, circle_onboard: 25, video_watch: 5 },
  // ASSUMPTION: video_watch counts once per account ("one-time boost").
  ONE_TIME_TASKS: ["video_watch"],
  // ASSUMPTION: hoarded energy decays 2%/day after 7 idle days, floor 0.
  DECAY: { graceDays: 7, ratePerDay: 0.02 },
  // ASSUMPTION: Seed bonus bands (brainstorm gives bands only, NOT multipliers; multipliers here are placeholders).
  // Bonus amplifies effort, never replaces it: final = energy * multiplier, so energy 0 => 0.
  SEED_BANDS: [ { minUsd: 0, mult: 1.0 }, { minUsd: 10, mult: 1.1 }, { minUsd: 1000, mult: 1.25 }, { minUsd: 10000, mult: 1.5 }, { minUsd: 100000, mult: 2.0 } ],
  // Referral tree: brainstorm example ~10% / ~5%, max two levels. Referral energy -> airdrop pool only,
  // NEVER race or championship, and NOT amplified by Seed multiplier (ASSUMPTION on the Seed part).
  REFERRAL: { levels: [0.10, 0.05] },
  // Day-30/60 gate (from research brief Concept C): referee must be active ON or AFTER day 30
  // (for 50% credit) and day 60 (for 100%) after binding. ASSUMPTION: 50/50 tranche split, day boundary inclusive, UTC days.
  GATES: [ { day: 30, share: 0.5 }, { day: 60, share: 0.5 } ],
  // Championship: F1-style points for top 10 of each race (ASSUMPTION: 2010+ F1 table).
  F1_POINTS: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1],
  // Head start (owner rule, 2026-11-05): placement in the PREVIOUS round only. #1 gets +20 next round, decreasing
  // to #10 (non-zero); #11+ get 0. Owner specified #1=20 and top10>0; intermediate steps are a PROVISIONAL
  // ASSUMPTION (20,18,...,2). Applies to the next round only (never compounds), never in the first round, and only
  // if the account earns own energy that round. Replaces the old winner-5%/Seed-flat head start; the Seed
  // MULTIPLIER (SEED_BANDS) is unchanged.
  HEADSTART: { placement: [20, 18, 16, 14, 12, 10, 8, 6, 4, 2] },
  // Treasury-linked recognition index, based on CUMULATIVE RAISED (sum of positive inflows), NEVER wallet balance.
  // ASSUMPTION: index = clamp(floor + pct * cumulativeRaised, floor, cap). Unitless — NOT $ or tokens.
  TREASURY_CURVE: { floor: 100, pct: 0.01, cap: 100000 },
  // Classification thresholds on final score (ASSUMPTION).
  // BUG-2 (found by sim S9): original 400/250/150 put 76% of the sample board in Architect. Recalibrated to the
  // 35-day synthetic sample; still ABSOLUTE thresholds on cumulative score, so they drift over time (residual risk).
  CLASSES: [ { min: 2000, name: "Architect" }, { min: 1200, name: "Node" }, { min: 600, name: "Verifier" }, { min: 1, name: "Signal" }, { min: 0, name: "Unranked" } ],
  // OPEN OWNER DECISION: "everyone" vs "optin". Unresolved => exporter refuses real export.
  VISIBILITY: "UNDECIDED",
  BOARD_SIZE: 100,
});
