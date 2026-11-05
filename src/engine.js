// ONMX Gamification shared scoring engine — PROVISIONAL, NEW, UNAPPROVED LOGIC.
// No existing production scoring source was found (read-only check of OnchainNeo GitHub + /workspace).
// Used by BOTH the dashboard (index.html) and the simulation (sim/) — one implementation.
import { CONFIG } from "./config.js";

const DAY_MS = 86400000;
export function safeNum(x, cfg = CONFIG) {
  const n = Number(x);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, cfg.MAX_VALUE);
}
export function utcDay(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error("bad date: " + iso);
  return Math.floor(t / DAY_MS);
}
export function daysBetween(a, b) { return utcDay(b) - utcDay(a); }

// Energy for one task. effort <= 0 or unknown type => 0.
export function taskEnergy(task, cfg = CONFIG) {
  const w = cfg.TASK_WEIGHTS[task.type];
  if (!w) return 0;
  return Math.min(safeNum(task.effort, cfg) * w, cfg.MAX_VALUE);
}

// Base (own) energy per account from tasks, optional date window [from, to). One-time tasks dedup.
export function baseEnergy(tasks, { from, to } = {}, cfg = CONFIG) {
  const out = new Map(); const seenOnce = new Set();
  for (const t of tasks) {
    if (from && utcDay(t.date) < utcDay(from)) continue;
    if (to && utcDay(t.date) >= utcDay(to)) continue;
    if (cfg.ONE_TIME_TASKS.includes(t.type)) { const k = t.account + "|" + t.type; if (seenOnce.has(k)) continue; seenOnce.add(k); }
    out.set(t.account, Math.min((out.get(t.account) || 0) + taskEnergy(t, cfg), cfg.MAX_VALUE));
  }
  return out;
}

export function seedMultiplier(seedUsd, cfg = CONFIG) {
  const usd = safeNum(seedUsd, cfg); let m = 1;
  for (const b of cfg.SEED_BANDS) if (usd >= b.minUsd) m = b.mult;
  return m;
}
export function finalScore(energy, seedUsd, cfg = CONFIG) {
  const e = safeNum(energy, cfg); if (e === 0) return 0;
  return Math.min(e * seedMultiplier(seedUsd, cfg), cfg.MAX_VALUE);
}

// Decay of hoarded balance: daysIdle beyond grace compound at ratePerDay.
export function decayed(balance, daysIdle, cfg = CONFIG) {
  const b = safeNum(balance, cfg); const d = Math.max(0, Math.floor(Number(daysIdle) || 0) - cfg.DECAY.graceDays);
  if (d === 0) return b;
  return Math.max(0, b * Math.pow(1 - cfg.DECAY.ratePerDay, d));
}

// Build referral tree. bindings: [{referee, referrer, date}]. First valid binding wins; rejects self-refs,
// duplicates (stacking), unknown accounts, and any binding that would create a cycle.
export function buildReferralTree(bindings, accounts) {
  const parent = new Map(); const rejected = [];
  const known = accounts ? new Set(accounts) : null;
  const sorted = [...bindings].sort((a, b) => utcDay(a.date) - utcDay(b.date));
  for (const b of sorted) {
    if (!b.referee || !b.referrer) { rejected.push({ ...b, reason: "missing" }); continue; }
    if (b.referee === b.referrer) { rejected.push({ ...b, reason: "self" }); continue; }
    if (known && (!known.has(b.referee) || !known.has(b.referrer))) { rejected.push({ ...b, reason: "unknown" }); continue; }
    if (parent.has(b.referee)) { rejected.push({ ...b, reason: "duplicate" }); continue; }
    let cur = b.referrer, cycle = false, guard = 0;
    while (cur !== undefined && guard++ < 1e6) { if (cur === b.referee) { cycle = true; break; } cur = parent.get(cur)?.referrer; }
    if (cycle) { rejected.push({ ...b, reason: "cycle" }); continue; }
    parent.set(b.referee, { referrer: b.referrer, date: b.date });
  }
  return { parent, rejected };
}

// Share of referral credit unlocked for a referee given binding date, last-active date and as-of date.
export function gateShare(bindDate, lastActiveDate, asOf, cfg = CONFIG) {
  let s = 0;
  for (const g of cfg.GATES) {
    const gateDay = utcDay(bindDate) + g.day;
    if (utcDay(asOf) >= gateDay && lastActiveDate && utcDay(lastActiveDate) >= gateDay) s += g.share;
  }
  return Math.min(1, s);
}

// Referral (airdrop-only) energy. Uses referees' BASE energy (no Seed amplification), max cfg levels.
export function referralEnergy(tree, base, lastActive, asOf, cfg = CONFIG) {
  const out = new Map();
  for (const [referee, { date }] of tree.parent) {
    const share = gateShare(date, lastActive.get(referee), asOf, cfg);
    const e = (base.get(referee) || 0) * share; if (e === 0) continue;
    let cur = tree.parent.get(referee)?.referrer;
    for (let lvl = 0; lvl < cfg.REFERRAL.levels.length && cur !== undefined; lvl++) {
      out.set(cur, Math.min((out.get(cur) || 0) + e * cfg.REFERRAL.levels[lvl], cfg.MAX_VALUE));
      cur = tree.parent.get(cur)?.referrer;
    }
  }
  return out;
}

export function headStart({ wonPrev, prevWinScore, seedUsd }, cfg = CONFIG) {
  const H = cfg.HEADSTART; let h = 0;
  if (wonPrev) h += Math.min(safeNum(prevWinScore, cfg) * H.winnerPct, H.winnerCap);
  if (safeNum(seedUsd, cfg) >= cfg.SEED_BANDS[1].minUsd) h += H.seedFlat;
  return Math.min(h, H.totalCap);
}

function rankSort(rows) {
  return rows.sort((a, b) => b.score - a.score || (a.tiebreak || "").localeCompare(b.tiebreak || "") || a.account.localeCompare(b.account));
}

// One race. Race score = finalScore(own energy in window, seed) + headStart (only if >0 own energy). Referral excluded.
export function scoreRace(race, tasks, accounts, prevWinner, cfg = CONFIG) {
  const base = baseEnergy(tasks, race, cfg);
  const rows = [];
  for (const a of accounts) {
    const own = finalScore(base.get(a.account) || 0, a.seedUsd, cfg);
    const hs = own > 0 ? headStart({ wonPrev: prevWinner?.account === a.account, prevWinScore: prevWinner?.own, /* BUG-1 fix: use pre-head-start score so head start cannot compound */ seedUsd: a.seedUsd }, cfg) : 0;
    rows.push({ account: a.account, own, headStart: hs, score: Math.min(own + hs, cfg.MAX_VALUE) });
  }
  rankSort(rows).forEach((r, i) => { r.rank = i + 1; r.points = r.score > 0 ? (cfg.F1_POINTS[i] || 0) : 0; });
  return rows;
}

export function championship(races, tasks, accounts, cfg = CONFIG) {
  const totals = new Map(accounts.map(a => [a.account, { account: a.account, points: 0, wins: 0 }]));
  const results = []; let prev = null;
  for (const race of races) {
    const rows = scoreRace(race, tasks, accounts, prev, cfg);
    for (const r of rows) { const t = totals.get(r.account); t.points += r.points; if (r.rank === 1 && r.score > 0) t.wins++; }
    prev = rows[0].score > 0 ? rows[0] : null;
    results.push({ id: race.id, rows });
  }
  const standings = [...totals.values()].sort((a, b) => b.points - a.points || b.wins - a.wins || a.account.localeCompare(b.account));
  standings.forEach((s, i) => s.rank = i + 1);
  return { results, standings };
}

// Cumulative raised: sum of POSITIVE inflows only. Wallet balance is deliberately not an input.
export function cumulativeRaised(inflows, cfg = CONFIG) {
  let s = 0; for (const f of inflows) s = Math.min(s + safeNum(f.amountUsd, cfg), cfg.MAX_VALUE); return s;
}
export function treasuryIndex(cumRaised, cfg = CONFIG) {
  const c = cfg.TREASURY_CURVE; const v = c.floor + c.pct * safeNum(cumRaised, cfg);
  return Math.min(Math.max(v, c.floor), c.cap);
}

export function classify(score, cfg = CONFIG) { for (const c of cfg.CLASSES) if (score >= c.min) return c.name; return "Unranked"; }
export function rewardLabel(cls) { // recognition only — never $ / token
  return { Architect: "Featured credit · Builder Grant review (pending)", Node: "Featured thread credit", Verifier: "Verifier badge", Signal: "Badge only", Unranked: "—" }[cls];
}
export function nextStep(cls) {
  return { Architect: "Review 1 newcomer Receipts guide", Node: "Ship 1 Architect explainer this week", Verifier: "Complete this month's Receipt Check", Signal: "Finish Verifier checklist", Unranked: "Complete first Receipt Check" }[cls];
}
export function xLink(handle) {
  const h = String(handle || "").replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) return null;
  return "https://x.com/" + h;
}

// Leaderboard rows 1..BOARD_SIZE with gap guidance and optional target position.
export function leaderboard(accounts, tasks, { asOf, targetRank } = {}, cfg = CONFIG) {
  const base = baseEnergy(tasks, { to: asOf }, cfg);
  const rows = accounts.map(a => ({ account: a.account, handle: a.handle, synthetic: !!a.synthetic, tiebreak: a.verifierDate || "9999",
    score: Math.round(finalScore(base.get(a.account) || 0, a.seedUsd, cfg)) }));
  rankSort(rows);
  const top = rows.slice(0, cfg.BOARD_SIZE);
  top.forEach((r, i) => {
    r.rank = i + 1; r.classification = classify(r.score, cfg); r.reward = rewardLabel(r.classification); r.xUrl = xLink(r.handle);
    r.gapToFirst = top[0].score - r.score;
    r.gapToAhead = i > 0 ? top[i - 1].score - r.score + 1 : 0;
    r.leadOverSecond = i === 0 && top[1] ? r.score - top[1].score : null;
    const t = targetRank && targetRank < r.rank ? top[targetRank - 1] : null;
    r.gapToTarget = t ? t.score - r.score + 1 : null;
    r.next = nextStep(r.classification);
  });
  return top;
}
