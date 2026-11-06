/**
 * Server-authoritative season / treasury-buy policy (PROVISIONAL).
 * Mirrors src/config.js exp-v1; Worker is source of truth for claims.
 */

export const POLICY = Object.freeze({
  version: "claims-policy-v1",
  formulaVersion: "exp-v1",
  capPoints: 250,
  scaleUsd: 1000,
  seasonNumber: 1,
  seasonStart: "2026-11-09T12:00:00-05:00",
  seasonEnd: "2026-11-23T12:00:00-05:00",
  lifetimeStart: "2026-11-09T12:00:00-05:00",
  // Pre-launch purchases stay UNASSIGNED until owner instruction — never silently backdated.
  prelaunchAssignment: "unassigned",
  nextSeasonNumber: 2, // explicit queue target for same-season subsequent purchases
  contracts: Object.freeze({
    bnbChainId: 56,
    ethChainId: 1,
    seedSaleBnb: "0x933c05b86dbd2234a23810f5d447b4537a907b08",
    seedSaleEth: "0x08c701207be45e8884fa48572a0517efba796cc0",
    // Magna vesting is NOT the sale
    magnaSeedVestingBnb: "0x7658e0a72ef50b319e99841f2b501c8013019b1d",
    usdtDecimalsBnb: 18,
    usdtDecimalsEth: 6,
  }),
  receiptVerification: "decoder_implemented_grants_off",
});

export function toInstantMs(iso) {
  const s = String(iso ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(s + "T12:00:00-05:00");
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error("bad date: " + iso);
  return t;
}

/** points = min(cap, round(cap * (1 - exp(-usd/scale)), 2)) */
export function treasuryBuyPoints(usd, policy = POLICY) {
  const cap = Number(policy.capPoints) || 0;
  const scale = Number(policy.scaleUsd) || 0;
  const x = Number(usd);
  if (!Number.isFinite(x) || x <= 0 || !(cap > 0) || !(scale > 0)) return 0;
  const raw = cap * (1 - Math.exp(-x / scale));
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const rounded = Math.round(raw * 100) / 100;
  return Math.min(cap, Math.max(0, rounded));
}

export function classifyPurchaseTime(purchaseMs, policy = POLICY) {
  const life = toInstantMs(policy.lifetimeStart);
  const start = toInstantMs(policy.seasonStart);
  const end = toInstantMs(policy.seasonEnd);
  if (purchaseMs < life || purchaseMs < start) {
    return {
      purchaseSeason: null,
      awardSeason: null,
      queueReason: "unassigned_prelaunch",
      status: "unassigned",
    };
  }
  if (purchaseMs >= start && purchaseMs < end) {
    return {
      purchaseSeason: policy.seasonNumber,
      awardSeason: policy.seasonNumber, // may be overridden to next if claim already exists
      queueReason: "first_in_season",
      status: "in_season",
    };
  }
  // After season end — not silently awarded; explicit future queue only via policy lock
  return {
    purchaseSeason: null,
    awardSeason: null,
    queueReason: "outside_season_unassigned",
    status: "unassigned",
  };
}

/**
 * Decide award season given existing in-season claims for this identity.
 * First eligible in-season → current season. Later same-season → next season queue (locked).
 * Does NOT increase current-season claim points.
 */
export function resolveAwardSeason({ classification, existingCurrentSeasonClaims }, policy = POLICY) {
  if (classification.status === "unassigned") {
    return {
      purchaseSeason: null,
      awardSeason: null,
      queueReason: classification.queueReason,
      pointsApply: false,
    };
  }
  if ((existingCurrentSeasonClaims || 0) === 0) {
    return {
      purchaseSeason: classification.purchaseSeason,
      awardSeason: classification.awardSeason,
      queueReason: "first_in_season",
      pointsApply: true,
    };
  }
  return {
    purchaseSeason: classification.purchaseSeason,
    awardSeason: policy.nextSeasonNumber,
    queueReason: "next_season_queue",
    pointsApply: true, // snapshot points stored; awarded to next season only
  };
}

export function publicConfig(env) {
  const xConfigured = Boolean(env.X_CLIENT_ID && env.X_CLIENT_SECRET && env.X_REDIRECT_URI);
  const sessionConfigured = Boolean(env.SESSION_SECRET && String(env.SESSION_SECRET).length >= 32);
  const rpcConfigured = Boolean(env.BNB_RPC_URL || env.ETH_RPC_URL);
  return {
    service: "onmx-gamification-claims",
    provisional: true,
    policyVersion: POLICY.version,
    formulaVersion: POLICY.formulaVersion,
    formula: "points=min(250, round(250*(1-exp(-USD/1000)),2))",
    capPointsPerPlayerSeason: POLICY.capPoints,
    season: {
      number: POLICY.seasonNumber,
      start: POLICY.seasonStart,
      end: POLICY.seasonEnd,
      lifetimeStart: POLICY.lifetimeStart,
      nextSeasonNumber: POLICY.nextSeasonNumber,
    },
    prelaunchPurchases: "unassigned_until_owner_instruction",
    readiness: {
      sessionSecrets: sessionConfigured,
      xOAuth: xConfigured,
      // Code implements full PKCE; UI login only when secrets present. Still no production grants.
      xLoginEnabled: xConfigured,
      xLoginUiSafe: xConfigured, // parent still must supply product app secrets
      sessionModes: ["bearer", "cookie"],
      preferredCrossSiteSession: "bearer",
      // Human/derived; nested `receipts` on /v1/config carries full decoder status.
      receiptVerification: "decoder_implemented_grants_off",
      rpc: rpcConfigured,
      productionGrantsEnabled: false,
      ordinaryPlayRequiresWallet: false,
      eip1271: rpcConfigured ? "optional_eth_call" : "unsupported_without_rpc",
    },
    blockers: [
      !sessionConfigured && "SESSION_SECRET missing or too short",
      !xConfigured && "X OAuth app secrets not configured (X_CLIENT_ID / X_CLIENT_SECRET / X_REDIRECT_URI)",
      "Seed sale decoder implemented (ETH+BNB mined cross-checked); production grants OFF until X OAuth secrets + owner prelaunch policy",
      !rpcConfigured && "BNB_RPC_URL / ETH_RPC_URL unset — public RPC defaults used for receipts; EIP-1271 optional eth_call needs reachable RPC",
    ].filter(Boolean),
    contracts: POLICY.contracts,
    corsOrigin: env.ALLOWED_ORIGIN || "https://onchain-matrix.github.io",
  };
}
