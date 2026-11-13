/**
 * LEGACY — Season 1 referral PROTOTYPE (browser-local). Retired: the live model is server-side (Worker + D1,
 * see worker/src/signals). Kept for helper functions (canonHandle/decodeRef) and old tests only.
 *
 * Season 1 referral PROTOTYPE (browser-local).
 *
 * POLICY (documented for Season 2 tuning):
 * - Bonuses are LIFETIME-ONLY Credits. They never enter season credit windows,
 *   BNB leaderboard ranking, or championship points.
 * - Signups before campaign launch (lifetimeStart) are accepted as PENDING;
 *   bonuses activate at lifetimeStart (not earned until then).
 * - Signups after launch grant immediately only while referral.enabled and
 *   CURRENT season number is in referral.enabledSeasons.
 * - After the enabled season ends, new referred signups are rejected.
 * - Idempotent per (canonicalNewHandle + campaignId). Never rewards visits/copies.
 * - Prototype storage is injected (localStorage in the dashboard). No backend,
 *   no verified accounts, no payout entitlement.
 *
 * Season 2: flip referral.enabled / enabledSeasons / credit amounts in SEASON config.
 */
export function canonHandle(raw) {
  const h = String(raw ?? "").trim().replace(/^@+/, "").toLowerCase();
  if (!h || !/^[a-z0-9_]{1,15}$/.test(h)) return null;
  return "@" + h;
}

export function encodeRef(handle) {
  const c = canonHandle(handle);
  return c ? encodeURIComponent(c.slice(1)) : null;
}

export function decodeRef(param) {
  if (param == null || param === "") return null;
  try { return canonHandle(decodeURIComponent(String(param))); }
  catch { return canonHandle(param); }
}

export function referralLink(baseUrl, handle) {
  const enc = encodeRef(handle);
  if (!enc) return null;
  const base = String(baseUrl || "").replace(/\?.*$/, "").replace(/\/$/, "") + "/";
  return `${base}?ref=${enc}`;
}

export function emptyStore() {
  return { campaignId: "onmx-campaign", regs: Object.create(null), grants: Object.create(null) };
}

function load(storeApi) {
  const raw = storeApi.get();
  if (!raw) return emptyStore();
  try {
    const j = typeof raw === "string" ? JSON.parse(raw) : raw;
    return { campaignId: j.campaignId || "onmx-campaign", regs: j.regs || {}, grants: j.grants || {} };
  } catch { return emptyStore(); }
}

function save(storeApi, data) { storeApi.set(JSON.stringify(data)); }

/**
 * @param {object} opts
 * @param {string} opts.referrerRaw
 * @param {string} opts.newRaw
 * @param {Set<string>|string[]} opts.rosterAccounts canonical @handles in sample/live roster
 * @param {object} opts.cfg SEASON.referral + lifetimeStart + number + start/end
 * @param {Date|number|string} [opts.now]
 * @param {{get:Function,set:Function}} opts.storeApi
 */
export function registerReferral({ referrerRaw, newRaw, rosterAccounts, cfg, now, storeApi }) {
  const refCfg = cfg.referral || {};
  if (!refCfg.enabled) return { ok: false, error: "Referrals are disabled." };
  const seasonN = cfg.number;
  const enabledSeasons = refCfg.enabledSeasons || [seasonN];
  const referrer = canonHandle(referrerRaw);
  const neu = canonHandle(newRaw);
  if (!referrer) return { ok: false, error: "Invalid referrer handle." };
  if (!neu) return { ok: false, error: "Enter a valid X handle (1–15 letters, numbers, or _)." };
  if (referrer === neu) return { ok: false, error: "You can’t refer yourself." };

  const roster = new Set([...(rosterAccounts || [])].map(a => canonHandle(a)).filter(Boolean));
  const data = load(storeApi);
  const registered = new Set(Object.keys(data.regs));

  // Referrer must be roster member OR already locally registered (not an arbitrary token).
  if (!roster.has(referrer) && !registered.has(referrer)) {
    return { ok: false, error: "Unknown referrer. Use a link from a known contributor." };
  }
  if (roster.has(neu)) return { ok: false, error: "That handle is already on the sample roster." };
  if (registered.has(neu) || data.grants[neu]) return { ok: false, error: "That handle is already registered in this browser." };

  const t = now == null ? Date.now() : new Date(now).getTime();
  const launch = new Date(cfg.lifetimeStart).getTime();
  const seasonStart = new Date(cfg.start).getTime();
  const seasonEnd = new Date(cfg.end).getTime();
  // New referrals only while this season is in enabledSeasons AND before season end.
  // Before launch: still allow PENDING signup if season is enabled (preview).
  if (!enabledSeasons.includes(seasonN)) return { ok: false, error: "Referrals aren’t enabled for this season." };
  if (t >= seasonEnd) return { ok: false, error: "Season referral window has closed." };

  const referrerCredits = Number(refCfg.referrerCredits) || 0;
  const welcomeCredits = Number(refCfg.welcomeCredits) || 0;
  const status = t < launch ? "pending" : "earned";
  // After launch, only grant if we're inside the active season window (or at/after season start).
  if (status === "earned" && t < seasonStart) {
    // Between... shouldn't happen if lifetimeStart === season start; treat as pending.
  }
  const grantStatus = t < launch ? "pending" : (t >= seasonStart && t < seasonEnd ? "earned" : "pending");
  // Clarify: if after launch and before season end => earned; if before launch => pending;
  // if after season end => rejected above.
  const finalStatus = t < launch ? "pending" : "earned";

  data.regs[neu] = { referrer, at: new Date(t).toISOString(), campaign: data.campaignId };
  data.grants[neu] = {
    referrer,
    referrerCredits,
    welcomeCredits,
    status: finalStatus,
    activatedAt: finalStatus === "earned" ? new Date(t).toISOString() : null,
    campaign: data.campaignId
  };
  save(storeApi, data);
  return { ok: true, handle: neu, referrer, status: finalStatus, referrerCredits, welcomeCredits };
}

/** Activate pending grants once now >= lifetimeStart (idempotent). */
export function activatePending({ cfg, now, storeApi }) {
  const t = now == null ? Date.now() : new Date(now).getTime();
  const launch = new Date(cfg.lifetimeStart).getTime();
  if (t < launch) return { activated: 0 };
  const data = load(storeApi);
  let n = 0;
  for (const [k, g] of Object.entries(data.grants)) {
    if (g.status === "pending") {
      g.status = "earned";
      g.activatedAt = new Date(Math.max(t, launch)).toISOString();
      n++;
    }
  }
  if (n) save(storeApi, data);
  return { activated: n };
}

export function statsFor(handleRaw, storeApi) {
  const h = canonHandle(handleRaw);
  if (!h) return { referrals: 0, bonusCredits: 0, pendingBonusCredits: 0, asReferred: null };
  const data = load(storeApi);
  let referrals = 0, bonusCredits = 0, pendingBonusCredits = 0;
  for (const g of Object.values(data.grants)) {
    if (g.referrer !== h) continue;
    referrals++;
    if (g.status === "earned") bonusCredits += Number(g.referrerCredits) || 0;
    else pendingBonusCredits += Number(g.referrerCredits) || 0;
  }
  const asReferred = data.grants[h] || null;
  return { referrals, bonusCredits, pendingBonusCredits, asReferred };
}

/** Lifetime credit bonus in RAW points (credits * pointsPerCredit). Season score untouched. */
export function lifetimeReferralRaw(handleRaw, storeApi, pointsPerCredit = 100) {
  const h = canonHandle(handleRaw);
  if (!h) return 0;
  const data = load(storeApi);
  let credits = 0;
  const st = statsFor(h, storeApi);
  credits += st.bonusCredits;
  const mine = data.grants[h];
  if (mine && mine.status === "earned") credits += Number(mine.welcomeCredits) || 0;
  return credits * pointsPerCredit;
}

export function listLocalHandles(storeApi) {
  return Object.keys(load(storeApi).regs);
}
