// DRY-RUN SIMULATION — fake accounts/tasks/referrals only, using the SAME engine as the dashboard (src/engine.js).
// Writes sim/output.json. Results describe the PROVISIONAL rules' mechanics, not real human behaviour.
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as E from "../src/engine.js";
import { rng, makeAccounts, makeTasks, addDays } from "./synth.js";
const SEED = Number(process.env.SIM_SEED || 20261105);
const scen = [];
const add = (name, metrics, checks) => scen.push({ name, metrics, checks, pass: checks.every(c => c.pass) });
const races = Array.from({ length: 10 }, (_, i) => ({ id: "R" + (i + 1), from: addDays("2026-11-09", i * 14), to: addDays("2026-11-09", (i + 1) * 14) }));

// S1 championship 10 races x 14 days
{ const a = makeAccounts(300, SEED); const tk = makeTasks(a, "2026-11-09", 140, SEED + 1); const c = E.championship(races, tk, a);
  const winners = c.results.map(r => r.rows[0].account); let maxStreak = 1, s = 1; for (let i = 1; i < winners.length; i++) { s = winners[i] === winners[i - 1] ? s + 1 : 1; maxStreak = Math.max(maxStreak, s); }
  const hsDecided = c.results.filter(r => r.rows[0].headStart > 0 && r.rows[0].own < r.rows[1].score).length;
  const maxHsShare = Math.max(...c.results.map(r => r.rows[0].score ? r.rows[0].headStart / r.rows[0].score : 0));
  add("S1 championship 10 races (300 fake accounts)", { distinctWinners: new Set(winners).size, maxConsecutiveWins: maxStreak, headStartDecidedWins: hsDecided, maxHeadStartShareOfWinnerScore: +maxHsShare.toFixed(4), champion: c.standings[0], top3: c.standings.slice(0, 3) },
    [{ cond: "head-start-decided wins <= 2 of 10", pass: hsDecided <= 2 }, { cond: "max head start <= 60 pts (bounded)", pass: c.results.every(r => r.rows.every(x => x.headStart <= 60)) }, { cond: "championship pts == sum of race pts", pass: c.standings.reduce((p, x) => p + x.points, 0) === c.results.reduce((p, r) => p + r.rows.reduce((q, x) => q + x.points, 0), 0) }]); }

// S2 KOL surge: 100k direct referrals
{ const t0 = Date.now(); const N = 100000; const r = rng(SEED + 2);
  const accounts = [{ account: "KOL", seedUsd: 0 }, { account: "GRINDER", seedUsd: 0 }];
  const bindings = []; const tasks = [{ account: "KOL", type: "architect_ship", effort: 3, date: "2026-11-10" }, { account: "GRINDER", type: "architect_ship", effort: 2, date: "2026-11-10" },
    { account: "KOL", type: "receipt_check", effort: 1, date: "2026-11-24" }, { account: "GRINDER", type: "architect_ship", effort: 2, date: "2026-11-24" }];
  const lastActive = new Map();
  for (let i = 0; i < N; i++) { const id = "F" + i; accounts.push({ account: id, seedUsd: 0 }); bindings.push({ referee: id, referrer: "KOL", date: "2026-11-09" });
    tasks.push({ account: id, type: "receipt_check", effort: 1, date: "2026-11-10" }); const retained = r() < 0.08; lastActive.set(id, retained ? "2027-01-20" : "2026-11-12"); }
  const tree = E.buildReferralTree(bindings); const base = E.baseEnergy(tasks);
  const refDay0 = E.referralEnergy(tree, base, lastActive, "2026-11-10").get("KOL") || 0;
  const refDay30 = E.referralEnergy(tree, base, lastActive, "2026-12-09").get("KOL") || 0;
  const refDay60 = E.referralEnergy(tree, base, lastActive, "2027-01-08").get("KOL") || 0;
  const c = E.championship(races.slice(0, 2), tasks, accounts);
  const rk = (ri, id) => c.results[ri].rows.find(x => x.account === id);
  add("S2 KOL surge (100k direct fake referrals, 8% synthetic retention)", { referralEnergyDay0: refDay0, referralEnergyDay30: refDay30, referralEnergyDay60: refDay60, kolRace1: rk(0, "KOL"), kolRace2: rk(1, "KOL"), grinderRace2: rk(1, "GRINDER"), runtimeMs: Date.now() - t0 },
    [{ cond: "referral energy 0 before day-30 gate", pass: refDay0 === 0 }, { cond: "KOL race score excludes referral energy", pass: rk(0, "KOL").own === 180 },
     { cond: "KOL does not repeat win in race 2 vs higher-effort grinder", pass: rk(1, "GRINDER").rank < rk(1, "KOL").rank }, { cond: "100k bindings run < 10s", pass: Date.now() - t0 < 10000 }]); }

// S3 referral abuse: depth-10 sybil chain, self/dup/cycles
{ const b = []; for (let i = 1; i <= 10; i++) b.push({ referee: "S" + i, referrer: "S" + (i - 1), date: "2026-11-01" });
  b.push({ referee: "S0", referrer: "S10", date: "2026-11-02" }, { referee: "S5", referrer: "S5", date: "2026-11-02" }, { referee: "S3", referrer: "X", date: "2026-11-02" });
  const tree = E.buildReferralTree(b); const base = new Map([["S10", 1000]]); const re = E.referralEnergy(tree, base, new Map([["S10", "2027-02-01"]]), "2027-02-01");
  const paid = [...re.keys()].sort();
  add("S3 referral abuse (depth-10 chain, cycle, self, duplicate)", { rejected: tree.rejected.map(x => x.reason), paidAccounts: paid, totalPaid: [...re.values()].reduce((p, x) => p + x, 0) },
    [{ cond: "only 2 ancestors paid (no L3+)", pass: paid.join() === "S8,S9" }, { cond: "total payout = 15% of referee base", pass: [...re.values()].reduce((p, x) => p + x, 0) === 150 }, { cond: "cycle/self/dup all rejected", pass: tree.rejected.map(x => x.reason).sort().join() === "cycle,duplicate,self" }]); }

// S4 Seed vs effort
{ const whale0 = E.finalScore(0, 1e6), whale = E.finalScore(100, 1e6), free = E.finalScore(201, 0);
  add("S4 freemium: Seed amplifies, never replaces effort", { whaleZeroEffort: whale0, whale100Energy: whale, free201Energy: free, effortRatioFreeNeedsToBeatMaxSeed: 2.0, plusSeedHeadStartPts: 20 },
    [{ cond: "0 effort => 0 regardless of Seed", pass: whale0 === 0 }, { cond: "free player with >2x energy beats max-band Seed", pass: free > whale }]); }

// S5 decay
{ const d = [0, 7, 14, 30, 60, 90].map(x => [x, +E.decayed(1000, x).toFixed(2)]);
  add("S5 energy decay of 1000 hoarded energy", { byIdleDays: Object.fromEntries(d) }, [{ cond: "monotonic non-increasing, never negative", pass: d.every((x, i) => x[1] >= 0 && (i === 0 || x[1] <= d[i - 1][1])) }]); }

// S6 treasury curve (cumulative raised only)
{ const series = [[], [{ amountUsd: 0 }], [{ amountUsd: -10000 }], [{ amountUsd: 50000 }, { amountUsd: -40000 }], [{ amountUsd: 1e6 }], [{ amountUsd: 9.99e6 }], [{ amountUsd: 5e7 }]];
  const pts = series.map(s => ({ inflows: s.map(x => x.amountUsd), cumulativeRaised: E.cumulativeRaised(s), index: E.treasuryIndex(E.cumulativeRaised(s)) }));
  add("S6 treasury-linked recognition index", { points: pts, capReachedAtCumulativeRaised: 9990000 },
    [{ cond: "zero/negative => floor 100", pass: pts[0].index === 100 && pts[1].index === 100 && pts[2].index === 100 }, { cond: "outflow does not reduce index (cumulative, not balance)", pass: pts[3].index === E.treasuryIndex(50000) }, { cond: "bounded by cap", pass: pts[6].index === 100000 }]); }

// S7 badge test pipeline — two randomized cohorts, SYNTHETIC return model with an INJECTED effect.
function badgeRun(effect, seed) { const r = rng(seed); const n = 4000; const coh = { badges: [0, 0], ranksOnly: [0, 0] };
  for (let i = 0; i < n; i++) { const g = r() < 0.5 ? "badges" : "ranksOnly"; const p = 0.20 + (g === "badges" ? effect : 0); coh[g][0]++; if (r() < p) coh[g][1]++; }
  const pb = coh.badges[1] / coh.badges[0], pr = coh.ranksOnly[1] / coh.ranksOnly[0];
  const se = Math.sqrt(pb * (1 - pb) / coh.badges[0] + pr * (1 - pr) / coh.ranksOnly[0]); const diff = pb - pr;
  return { n: { badges: coh.badges[0], ranksOnly: coh.ranksOnly[0] }, day30Return: { badges: +pb.toFixed(4), ranksOnly: +pr.toFixed(4) }, diff: +diff.toFixed(4), ci95: [+(diff - 1.96 * se).toFixed(4), +(diff + 1.96 * se).toFixed(4)] }; }
{ const nul = badgeRun(0, SEED + 7), pos = badgeRun(0.05, SEED + 8);
  add("S7 badge cohort instrumentation (synthetic: badges visible vs ranks only)", { note: "Effect is an INPUT to the fake return model; output only shows the pipeline recovers it. NOT evidence about real people.", nullEffect: nul, injectedEffect005: pos },
    [{ cond: "null run CI contains 0", pass: nul.ci95[0] <= 0 && nul.ci95[1] >= 0 }, { cond: "injected +0.05 recovered within CI", pass: pos.ci95[0] <= 0.05 && pos.ci95[1] >= 0.05 }, { cond: "cohorts balanced within 5%", pass: Math.abs(nul.n.badges - nul.n.ranksOnly) / 4000 < 0.05 }]); }

// S9 classification calibration on the dashboard's own sample data window (35 days)
{ const a = makeAccounts(120, 42); const rows = E.leaderboard(a, makeTasks(a, "2026-10-01", 35, 7), { asOf: "2026-11-06" });
  const dist = {}; for (const r of rows) dist[r.classification] = (dist[r.classification] || 0) + 1;
  add("S9 classification calibration (sample board, 35 days)", { distribution: dist, note: "absolute thresholds vs cumulative score" },
    [{ cond: "no single class > 60% of board", pass: Math.max(...Object.values(dist)) / rows.length <= 0.6 }]); }

// S8 determinism
{ const h = () => { const a = makeAccounts(100, SEED); return createHash("sha256").update(JSON.stringify(E.championship(races.slice(0, 3), makeTasks(a, "2026-11-09", 42, SEED), a))).digest("hex"); };
  const h1 = h(), h2 = h(); add("S8 reproducibility", { sha256: h1 }, [{ cond: "same seed => identical hash", pass: h1 === h2 }]); }

const summary = { seed: SEED, scenarios: scen.length, passed: scen.filter(s => s.pass).length, failed: scen.filter(s => !s.pass).length, SYNTHETIC: true };
writeFileSync(new URL("./output.json", import.meta.url), JSON.stringify({ summary, scenarios: scen }, null, 1));
console.log(JSON.stringify(summary)); for (const s of scen) for (const c of s.checks) if (!c.pass) console.log("FAIL", s.name, "::", c.cond);
