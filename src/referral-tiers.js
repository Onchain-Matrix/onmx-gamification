/**
 * Season 1 referral policy (owner approved Nov 18 2026, pre-launch correction; replaces referral-tiered-v1).
 * Shared by the public UI and the Worker. The Worker is authoritative for granted points.
 *
 * - Level 1: the inviter earns 5% of the points their invited player earns from approved signals
 *   (base + reviewer-confirmed outcome bonus).
 * - Level 2: the inviter's own inviter earns 2.5% of those points.
 * - Cap: 250,000 referral points per account per season (level 1 + level 2 combined). Above the cap a grant is cut to the
 *   remaining room, then 0.
 * - One inviter per player, set only when the player joins (never added later, never changed). No self-referral.
 * - Referral links (/referral/<handle>) are remembered for 30 days. No retroactive claims after that.
 * - Referral points are lifetime-only (never the season prize ranking), per the 6 Nov 2026 owner policy.
 * Shares are stored as exact REAL ledger values (e.g. 0.25, 0.125) — not rounded to whole points.
 */
export const REFERRAL_POLICY = Object.freeze({
  version: "referral-pct-v1",
  l1Percent: 5,
  l2Percent: 2.5,
  capPointsPerSeason: 250000,
  linkDays: 30,
  welcomeCredits: 0,
  earnOn: "approved_signal_points",
  creditsScope: "lifetime_only",
});
/** @deprecated alias kept for older imports; same object as REFERRAL_POLICY. */
export const REFERRAL_TIERS = REFERRAL_POLICY;

/** Round to 6 decimals so 5% / 2.5% shares of whole or half points store exactly (0.25, 0.125, 0.0625…). */
function r6(x) {
  return Math.round(x * 1e6) / 1e6;
}

/** Level-1 share of a recruit's approved points. */
export function referralL1Points(points, p = REFERRAL_POLICY) {
  const x = Number(points);
  if (!Number.isFinite(x) || x <= 0) return 0;
  return r6((x * p.l1Percent) / 100);
}

/** Level-2 share of a recruit's approved points. */
export function referralL2Points(points, p = REFERRAL_POLICY) {
  const x = Number(points);
  if (!Number.isFinite(x) || x <= 0) return 0;
  return r6((x * p.l2Percent) / 100);
}

/** Apply the per-season cap: grant at most the room left. */
export function capReferralGrant(amount, alreadyThisSeason, p = REFERRAL_POLICY) {
  const a = Number(amount) || 0;
  const used = Number(alreadyThisSeason) || 0;
  const room = Math.max(0, p.capPointsPerSeason - used);
  return r6(Math.max(0, Math.min(a, room)));
}

export function formatPoints(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "0";
  return x.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

export function referralTierHeadline(p = REFERRAL_POLICY) {
  return `${formatPoints(p.l1Percent)}% + ${formatPoints(p.l2Percent)}%`;
}

export function referralTierRangeLabel(p = REFERRAL_POLICY) {
  return `Level 1 · Level 2 · cap ${formatPoints(p.capPointsPerSeason)} per season`;
}

export function referralHowToCopy(p = REFERRAL_POLICY) {
  return `Share your referral link. You earn ${formatPoints(p.l1Percent)}% of the points your invited friends earn from approved signals, and ${formatPoints(p.l2Percent)}% of the points earned by players they invite. Referral points are capped at ${formatPoints(p.capPointsPerSeason)} per account per season and count toward your lifetime total only, never toward the Season 1 prize ranking.`;
}

export function referralPanelCopy(seasonNumber, p = REFERRAL_POLICY) {
  return `You earn ${formatPoints(p.l1Percent)}% of the points your invited friends earn from approved signals, and ${formatPoints(p.l2Percent)}% of the points earned by players they invite (cap ${formatPoints(p.capPointsPerSeason)} referral points per season). Your link is remembered for ${p.linkDays} days after a friend opens it; a friend who joins after that, or without your link, can't be added later. Referral points count toward your lifetime total, not the Season ${seasonNumber} prize ranking.`;
}

export function referralRulesLines(p = REFERRAL_POLICY) {
  return {
    tiers: `Level 1: you earn ${formatPoints(p.l1Percent)}% of the points your invited friends earn from approved signals.`,
    level2: `Level 2: you earn ${formatPoints(p.l2Percent)}% of the points earned by players your friends invite.`,
    cap: `Referral points are capped at ${formatPoints(p.capPointsPerSeason)} per account per season (level 1 and level 2 combined).`,
    link: `A referral link is remembered for ${p.linkDays} days after it is opened. A player who joins without it, or after it expires, can't have an inviter added later.`,
  };
}
