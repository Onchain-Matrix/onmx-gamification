/**
 * Season 1 referral tiers (owner approved Nov 14 2026). Shared by the public UI and the Worker.
 * The Worker is authoritative for granted points. Referral earnings are lifetime-only
 * (never season / BNB ranking) per the 6 Nov 2026 owner policy.
 *
 * Level-1 points depend on how many qualified referrals that referrer already has THIS
 * SEASON, counting the one being credited: #1–10 → 10, #11–25 → 5, #26–50 → 2, #51–100 → 1.
 * Level 2 is always half of that referral's level-1 value (5 / 2.5 / 1 / 0.5).
 * Over the test cap (100 qualified per referrer per season) the row is tracked as over_cap and earns 0.
 * Halves are stored as REAL ledger values (2.5, 0.5) — not rounded.
 */
export const REFERRAL_TIERS = Object.freeze({
  version: "referral-tiered-v1",
  welcomeCredits: 0,
  capQualifiedPerSeason: 100, // test max; owner approved Nov 14 2026
  qualifyOn: "first_approved_signal",
  creditsScope: "lifetime_only",
  // Inclusive 1-based ranges. Last tier ends at the season cap.
  tiers: Object.freeze([
    Object.freeze({ from: 1, to: 10, l1: 10 }),
    Object.freeze({ from: 11, to: 25, l1: 5 }),
    Object.freeze({ from: 26, to: 50, l1: 2 }),
    Object.freeze({ from: 51, to: 100, l1: 1 }),
  ]),
});

/** Level-1 points for the n-th qualified referral this season (1-based, including this one). Over cap or invalid → 0. */
export function referralL1Points(nth, p = REFERRAL_TIERS) {
  const n = Number(nth);
  if (!Number.isFinite(n) || n < 1 || n > p.capQualifiedPerSeason) return 0;
  for (const t of p.tiers) {
    if (n >= t.from && n <= t.to) return t.l1;
  }
  return 0;
}

/** Level 2 is always half the level-1 value of the referral being credited. */
export function referralL2Points(l1) {
  return Number(l1) / 2;
}

export function formatPoints(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "0";
  return Number.isInteger(x) ? String(x) : String(x);
}

export function referralTierHeadline(p = REFERRAL_TIERS) {
  return p.tiers.map((t) => formatPoints(t.l1)).join(" / ") + " points";
}

export function referralTierRangeLabel(p = REFERRAL_TIERS) {
  return p.tiers.map((t) => `${t.from}–${t.to}`).join(" / ");
}

export function referralHowToCopy(p = REFERRAL_TIERS) {
  const [a, b, c, d] = p.tiers;
  const halves = p.tiers.map((t) => formatPoints(referralL2Points(t.l1))).join(" / ");
  return `You earn ${formatPoints(a.l1)} points for each of your first ${a.to} qualified referrals this season, then ${formatPoints(b.l1)} for referrals ${b.from}–${b.to}, ${formatPoints(c.l1)} for ${c.from}–${c.to}, and ${formatPoints(d.l1)} for ${d.from}–${d.to}. If a friend you invited refers someone, you get half of what they earn for that referral (${halves} points). Referral points count toward your lifetime total only, never toward the Season 1 prize ranking.`;
}

export function referralPanelCopy(seasonNumber, p = REFERRAL_TIERS) {
  const [a, b, c, d] = p.tiers;
  return `A referral qualifies when your friend's first signal is approved. You earn ${formatPoints(a.l1)} points for each of your first ${a.to} qualified referrals this season, then ${formatPoints(b.l1)} for referrals ${b.from}–${b.to}, ${formatPoints(c.l1)} for ${c.from}–${c.to}, and ${formatPoints(d.l1)} for ${d.from}–${d.to} (test max ${p.capQualifiedPerSeason} per season). If someone you invited refers a player, you get half of what they earn for that referral. Referral points count toward your lifetime total, not the Season ${seasonNumber} prize ranking.`;
}

export function referralRulesLines(p = REFERRAL_TIERS) {
  const halves = p.tiers.map((t) => formatPoints(referralL2Points(t.l1))).join(" / ");
  const tiers = p.tiers.map((t) => `${formatPoints(t.l1)} for ${t.from}–${t.to}`).join(", ");
  return {
    tiers: `Points per qualified referral this season: ${tiers}.`,
    level2: `If someone you invited refers a player, you get half of what they earn for that referral (${halves} points).`,
    cap: `Up to ${p.capQualifiedPerSeason} qualified referrals per referrer per season (test max). Further referrals are tracked but earn 0.`,
  };
}
