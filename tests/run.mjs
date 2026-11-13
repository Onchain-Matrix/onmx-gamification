// Deterministic tests for the shared engine (src/engine.js). Writes tests/results.json.
import { writeFileSync, readFileSync } from "node:fs";
import * as E from "../src/engine.js";
import { CONFIG, SEASON, SEASON_HISTORY, PUBLIC_UI, PRIZE_COPY, toInstantMs, inHalfOpenWindow, seasonStatus, completedSeasons, cumulativeChampionship, treasuryBuyPoints, proposedPrizeGrowthUsd, freezeTreasuryBuyClaim, queueTreasuryBuyForNextSeason, seasonBuyPointsTotal, SIGNALS, signalCredits, signalToTask } from "../src/config.js";
import * as Ref from "../src/referral.js";
import { transform } from "../tools/export-roster.mjs";
import { makeAccounts, makeTasks } from "../sim/synth.js";
const results = []; const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || ""} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (c, m) => { if (!c) throw new Error(m || "assert"); };
function t(name, fn) { try { fn(); results.push({ name, pass: true }); } catch (e) { results.push({ name, pass: false, error: e.message }); } }
const acc = (id, seedUsd = 0) => ({ account: id, handle: id.toLowerCase(), seedUsd });

t("effort=0 => score 0 (even with max Seed)", () => { eq(E.taskEnergy({ type: "receipt_check", effort: 0 }), 0); eq(E.finalScore(0, 1e6), 0); });
t("negative/NaN/Infinity effort => 0", () => { for (const v of [-5, NaN, Infinity, "x", null]) eq(E.taskEnergy({ type: "receipt_check", effort: v }), 0, String(v)); });
t("unknown task type => 0", () => eq(E.taskEnergy({ type: "follow", effort: 5 }), 0));
t("overflow clamps to MAX_VALUE", () => { eq(E.taskEnergy({ type: "architect_ship", effort: 1e308 }), CONFIG.MAX_VALUE); eq(E.finalScore(1e308, 1e6), CONFIG.MAX_VALUE);
  const b = E.baseEnergy(Array.from({ length: 50 }, () => ({ account: "A", type: "architect_ship", effort: 1e11, date: "2026-10-01" }))); eq(b.get("A"), CONFIG.MAX_VALUE); });
t("Seed bands tiered not linear", () => { eq([0, 9.99, 10, 999, 1000, 10000, 99999, 100000, 1e9].map(x => E.seedMultiplier(x)), [1, 1, 1.1, 1.1, 1.25, 1.5, 1.5, 2, 2]); });
t("energy x bonus", () => eq(E.finalScore(100, 10000), 150));
t("one-time video boost counted once", () => { const b = E.baseEnergy([1, 2, 3].map(() => ({ account: "A", type: "video_watch", effort: 1, date: "2026-10-01" }))); eq(b.get("A"), 5); });
t("decay: none within grace, compounds after", () => { eq(E.decayed(100, 7), 100); eq(+E.decayed(100, 8).toFixed(6), 98); ok(E.decayed(100, 10000) >= 0 && E.decayed(100, 10000) < 1e-6); eq(E.decayed(-50, 30), 0); });
t("referral: self-ref rejected", () => { const r = E.buildReferralTree([{ referee: "A", referrer: "A", date: "2026-10-01" }]); eq(r.parent.size, 0); eq(r.rejected[0].reason, "self"); });
t("referral: duplicate/stacking rejected, first wins", () => { const r = E.buildReferralTree([{ referee: "C", referrer: "A", date: "2026-10-01" }, { referee: "C", referrer: "B", date: "2026-10-02" }]); eq(r.parent.get("C").referrer, "A"); eq(r.rejected[0].reason, "duplicate"); });
t("referral: cycles rejected (2- and 3-cycle)", () => { const r = E.buildReferralTree([{ referee: "B", referrer: "A", date: "2026-10-01" }, { referee: "A", referrer: "B", date: "2026-10-02" },
  { referee: "C", referrer: "B", date: "2026-10-03" }, { referee: "A", referrer: "C", date: "2026-10-04" }]); eq(r.rejected.map(x => x.reason), ["cycle", "cycle"]); });
t("referral: 10%/5%, no L3", () => { const tree = E.buildReferralTree([{ referee: "B", referrer: "A", date: "2026-01-01" }, { referee: "C", referrer: "B", date: "2026-01-01" }, { referee: "D", referrer: "C", date: "2026-01-01" }]);
  const base = new Map([["D", 1000]]); const la = new Map([["D", "2026-06-01"]]); const r = E.referralEnergy(tree, base, la, "2026-06-01");
  eq(r.get("C"), 100); eq(r.get("B"), 50); eq(r.get("A"), undefined, "L3 must get nothing"); });
t("referral uses BASE energy, not Seed-amplified", () => { const tree = E.buildReferralTree([{ referee: "B", referrer: "A", date: "2026-01-01" }]); const r = E.referralEnergy(tree, new Map([["B", 100]]), new Map([["B", "2026-12-01"]]), "2026-12-01"); eq(r.get("A"), 10); });
t("gate edges: day29 0, day30 0.5, day59 0.5, day60 1", () => { const b = "2026-01-01";
  eq(E.gateShare(b, "2026-01-30", "2026-01-30"), 0, "day29"); eq(E.gateShare(b, "2026-01-31", "2026-01-31"), 0.5, "day30");
  eq(E.gateShare(b, "2026-03-01", "2026-03-01"), 0.5, "day59"); eq(E.gateShare(b, "2026-03-02", "2026-03-02"), 1, "day60");
  eq(E.gateShare(b, "2026-01-10", "2026-06-01"), 0, "inactive after day10"); eq(E.gateShare(b, "2026-12-01", "2026-01-15"), 0, "asOf before gate"); });
t("gate across leap day (2028-02-29) uses UTC day count", () => eq(E.gateShare("2028-02-01", "2028-03-02", "2028-03-02"), 0.5));
t("referral energy excluded from race/championship", () => { const accounts = [acc("A"), acc("B")];
  const tasks = [{ account: "A", type: "receipt_check", effort: 1, date: "2026-10-02" }, { account: "B", type: "receipt_check", effort: 2, date: "2026-10-02" }];
  const rows = E.scoreRace({ id: "R", from: "2026-10-01", to: "2026-10-15" }, tasks, accounts, null); eq(rows[0].account, "B"); eq(rows.find(r => r.account === "A").score, 10); });
t("head start: +25 #1-5, +15 #6-10, +5 #11-20, 0 #21+/none (raw scoring points)", () => { eq([1,4,5,6,9,10,11,15,20,21,100,0,null,undefined].map(r => E.headStart(r)), [25,25,25,15,15,15,5,5,5,0,0,0,0,0]); eq([25,15,5].map(p => p / CONFIG.POINTS_PER_BATTERY), [0.25,0.15,0.05]); });
t("credit display: 100 points = 1 credit", () => { eq(CONFIG.POINTS_PER_BATTERY, 100); eq([1400,3180,150,0,1,2453].map(v => v / CONFIG.POINTS_PER_BATTERY), [14,31.8,1.5,0,0.01,24.53]); });
t("head start: first round none; next round from prev placement only; no compounding; Seed gives no head start", () => {
  const accounts = Array.from({ length: 12 }, (_, i) => acc("A" + String(i).padStart(2, "0"), i === 11 ? 1e6 : 0)); const races = [1, 2, 3].map(i => ({ id: "R" + i, from: `2026-10-${String(i * 10 - 9).padStart(2, "0")}`, to: `2026-10-${String(i * 10 + 1).padStart(2, "0")}` }));
  const tasks = []; for (const r of races) accounts.forEach((a, i) => tasks.push({ account: a.account, type: "receipt_check", effort: 100 - i * 5, date: r.from.replace(/\d\d$/, d => String(+d + 1).padStart(2, "0")) }));
  const c = E.championship(races, tasks, accounts); const r1 = c.results[0].rows, r2 = c.results[1].rows, r3 = c.results[2].rows;
  ok(r1.every(x => x.headStart === 0), "no head start in first round");
  for (const p of r1) eq(r2.find(x => x.account === p.account).headStart, E.headStart(p.rank), "R2 hs from R1 rank " + p.rank);
  eq(r1.slice(0, 10).map(p => r2.find(x => x.account === p.account).headStart), [25,25,25,25,25,15,15,15,15,15]); eq(r1.slice(10, 12).map(p => r2.find(x => x.account === p.account).headStart), [5,5]);
  for (const p of r2) eq(r3.find(x => x.account === p.account).headStart, E.headStart(p.rank), "R3 hs from R2 rank only (no carry)");
  ok(Math.max(...c.results.flatMap(r => r.rows.map(x => x.headStart))) <= 25); });
t("head start zero when no own effort (never a free win)", () => { const rows = E.scoreRace({ id: "R", from: "2026-10-01", to: "2026-10-15" }, [], [acc("A", 1e6)], [{ account: "A", own: 1000, score: 1000, rank: 1 }]); eq(rows[0].score, 0); eq(rows[0].points, 0); eq(rows[0].headStart, 0); });
t("sample data: round 2 head starts = 25 (top5) / 15 (6-10) / 5 (11-20) from round 1", () => { const R = JSON.parse(readFileSync(new URL("../data/sample-roster.json", import.meta.url))), T = JSON.parse(readFileSync(new URL("../data/sample-tasks.json", import.meta.url))), TR = JSON.parse(readFileSync(new URL("../data/sample-treasury.json", import.meta.url)));
  const c = E.championship(TR.races, T.tasks, R.accounts); const [r1, r2] = c.results.map(r => r.rows); ok(r1.every(x => x.headStart === 0));
  const own2 = new Set(r2.filter(x => x.own > 0).map(x => x.account)); for (const p of r1) eq(r2.find(x => x.account === p.account).headStart, own2.has(p.account) && p.own > 0 ? E.headStart(p.rank) : 0, p.account);
  eq(E.headStart(r1[2].rank), 25, "rank 3 non-zero"); if (r1[10]) eq(E.headStart(r1[10].rank), 5, "rank 11 = +5"); if (r1[20]) eq(E.headStart(r1[20].rank), 0, "rank 21 = 0"); });
t("F1 points top10 and championship sums", () => { const accounts = Array.from({ length: 12 }, (_, i) => acc("A" + String(i).padStart(2, "0")));
  const tasks = accounts.map((a, i) => ({ account: a.account, type: "receipt_check", effort: 12 - i, date: "2026-10-02" }));
  const c = E.championship([{ id: "R1", from: "2026-10-01", to: "2026-10-15" }], tasks, accounts); eq(c.results[0].rows.map(r => r.points), [25, 18, 15, 12, 10, 8, 6, 4, 2, 1, 0, 0]); eq(c.standings[0].points, 25); });
t("treasury: cumulative raised ignores outflows; zero/negative => floor", () => { eq(E.cumulativeRaised([{ amountUsd: 100 }, { amountUsd: -50 }, { amountUsd: 0 }, { amountUsd: "NaN" }]), 100);
  eq(E.treasuryIndex(0), 100); eq(E.treasuryIndex(-1e9), 100); eq(E.treasuryIndex(1e6), 10100); eq(E.treasuryIndex(1e12), 100000); });
t("treasury index monotonic non-decreasing", () => { let p = -1; for (let x = 0; x <= 2e7; x += 5e5) { const v = E.treasuryIndex(x); ok(v >= p); p = v; } });
t("leaderboard: max 100 rows, ranks 1..100, x links valid", () => { const a = makeAccounts(150, 1); const rows = E.leaderboard(a, makeTasks(a, "2026-10-01", 20, 2), { asOf: "2026-10-21" });
  eq(rows.length, 100); eq(rows.map(r => r.rank), Array.from({ length: 100 }, (_, i) => i + 1)); ok(rows.every(r => r.xUrl && r.xUrl.startsWith("https://x.com/sample_syn_"))); });
t("leaderboard: gaps + target guidance correct", () => { const a = [acc("A"), acc("B"), acc("C")]; const tk = [["A", 5], ["B", 3], ["C", 1]].map(([x, e]) => ({ account: x, type: "receipt_check", effort: e, date: "2026-10-01" }));
  const r = E.leaderboard(a, tk, { targetRank: 1 }); eq(r[0].leadOverSecond, 20); eq(r[2].gapToAhead, 21); eq(r[2].gapToFirst, 40); eq(r[2].gapToTarget, 41); eq(r[0].gapToTarget, null); });
t("xLink rejects injection / invalid handles", () => { eq(E.xLink("@ok_1"), "https://x.com/ok_1"); eq(E.xLink("javascript:alert(1)"), null); eq(E.xLink("a/b"), null); eq(E.xLink("x".repeat(16)), null); });
t("exporter refuses while visibility UNDECIDED", () => { let threw = false; try { transform([], "UNDECIDED"); } catch { threw = true; } ok(threw); });
t("exporter optin filter + strips non-allowed fields + dedup", () => { const r = transform([{ account: "A", handle: "a", optIn: true, email: "x@y", wallet: "0x1" }, { account: "A", handle: "a", optIn: true }, { account: "B", handle: "b", optIn: false }], "optin");
  eq(r.accounts, [{ account: "A", handle: "a", optIn: true }]); eq(r.dropped.length, 2); });
t("determinism: same seed => identical leaderboard", () => { const f = () => { const a = makeAccounts(50, 9); return JSON.stringify(E.leaderboard(a, makeTasks(a, "2026-10-01", 10, 3))); }; eq(f(), f()); });

// --- Search regressions (search helper extracted from index.html; ranks via engine with display cap lifted) ---
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const src = html.split("// SEARCH-BEGIN")[1].split("// SEARCH-END")[0].replace(/^.*\n/, "");
const { searchRows } = new Function(src + "; return { searchRows, normHandle };")();
const full = (a, tk, asOf) => E.leaderboard(a, tk, { asOf }, { ...CONFIG, BOARD_SIZE: Infinity });
const roster = JSON.parse(readFileSync(new URL("../data/sample-roster.json", import.meta.url))); const stasks = JSON.parse(readFileSync(new URL("../data/sample-tasks.json", import.meta.url)));
t("search: sample data full ranking matches top-100 board exactly and covers all accounts", () => { const top = E.leaderboard(roster.accounts, stasks.tasks, { asOf: "2026-11-06" }); const all = full(roster.accounts, stasks.tasks, "2026-11-06");
  eq(all.length, roster.accounts.length); eq(top.length, Math.min(100, roster.accounts.length)); eq(all.slice(0, 100).map(r => [r.rank, r.handle, r.score]), top.map(r => [r.rank, r.handle, r.score]));
  for (const r of all) { const h = searchRows(all, "  @" + r.handle.toUpperCase() + " "); eq(h.length, 1); eq([h[0].rank, h[0].score], [r.rank, r.score]); } });
t("search: empty / whitespace / @ only => null; unknown => []", () => { const all = full(roster.accounts, stasks.tasks, "2026-11-06"); eq(searchRows(all, ""), null); eq(searchRows(all, "   "), null); eq(searchRows(all, "@"), null); eq(searchRows(all, "nobody_here"), []); eq(searchRows(all, "sample_syn_000"), [], "no partial match"); });
t("search: synthetic 10001 accounts — rank > 100 found with correct global rank/score", () => { const a = makeAccounts(10001, 3); const tk = makeTasks(a, "2026-10-01", 20, 2); const all = full(a, tk, "2026-10-21");
  eq(all.length, 10001); eq(E.leaderboard(a, tk, { asOf: "2026-10-21" }).length, 100); ok(all.every((r, i) => r.rank === i + 1 && (i === 0 || all[i - 1].score >= r.score)));
  for (const k of [101, 5000, 10000, 10001]) { const r = all[k - 1]; const h = searchRows(all, "@" + r.handle.toUpperCase()); eq(h.length, 1); eq(h[0].rank, k); eq(h[0].score, Math.round(E.finalScore(E.baseEnergy(tk, { to: "2026-10-21" }).get(r.account) || 0, a.find(x => x.account === r.account).seedUsd))); } });
t("search: duplicate handles return all exact matches; injection handle stays inert", () => { const a = [acc("A"), acc("B"), { account: "C", handle: "<img src=x onerror=alert(1)>", seedUsd: 0 }]; a[1].handle = "a";
  const all = full(a, [], "2026-10-21"); eq(searchRows(all, "@A").length, 2); const x = searchRows(all, "<IMG src=x onerror=alert(1)>"); eq(x.length, 1); eq(x[0].xUrl, null); });

t("no user-facing battery in index.html; Credits + Season 1 + airdrop after close", () => {
  const h = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  ok(!/batter(y|ies)/i.test(h), "no battery");
  ok(/Credits/.test(h) && /CURRENT_SEASON/.test(h));
  ok(/after Season 1 closes/.test(h));
  ok(/Credits earned during the campaign convert into airdrops/.test(h));
  ok(!/10,?000 energy = 1 token/i.test(h));
  ok(/assets\/onchainmatrix-logo\.png/.test(h));
  ok(/\{ CONFIG, SEASON/.test(h), "CONFIG/SEASON binding from config module");
  ok(/counting begins/.test(h));
  ok(/No Season 1 activity yet/.test(h));
  ok(/Lifetime credits · vs lifetime leader/.test(h));
});
const fmtCredits = pts => String((Math.round(Number(pts) / CONFIG.POINTS_PER_BATTERY * 100) / 100));
t("sample roster: account id is @handle; no SYN- ids; ranks/scores preserved vs handle map", () => {
  ok(roster.accounts.every(a => a.account === "@" + a.handle && !String(a.account).includes("SYN-")));
  ok(stasks.tasks.every(t => String(t.account).startsWith("@") && !String(t.account).includes("SYN-")));
  const all = full(roster.accounts, stasks.tasks, "2026-11-06");
  eq(all[0].handle, "sample_syn_0103"); eq(all[0].account, "@sample_syn_0103"); eq(all[0].score, 3180);
  eq(all[100].handle, "sample_syn_0053"); eq(all[100].score, 150);
  eq(fmtCredits(150), "1.5"); eq(fmtCredits(3180), "31.8");
});
t("season vs lifetime: prelaunch fixture => both 0; no NaN; lifetimeStart excludes prelaunch", () => {
  const lifeBase = E.baseEnergy(stasks.tasks, { from: "2026-11-18", to: "2026-11-06" }); // empty window when asOf before launch
  const lifeFromLaunch = E.baseEnergy(stasks.tasks, { from: "2026-11-18", to: "2026-12-01" });
  const seaBase = E.baseEnergy(stasks.tasks, { from: "2026-11-18", to: "2026-12-09" });
  let lifePos = 0, seaPos = 0;
  for (const a of roster.accounts) {
    const L = Math.round(E.finalScore(lifeFromLaunch.get(a.account) || 0, a.seedUsd));
    const S = Math.round(E.finalScore(seaBase.get(a.account) || 0, a.seedUsd));
    ok(Number.isFinite(L) && Number.isFinite(S) && L >= 0 && S >= 0 && !Number.isNaN(L) && !Number.isNaN(S));
    if (L > 0) lifePos++; if (S > 0) seaPos++;
  }
  eq(seaPos, 0, "no sample tasks inside Season 1 window");
  eq(lifePos, 0, "sample tasks are all prelaunch — lifetime from Nov 18 also 0");
  ok(SEASON.lifetimeStart === "2026-11-18T12:00:00-05:00");
  ok(html.includes("LIFETIME_START"));
});
t("season/lifetime boundaries: prelaunch excluded from both; launch included; season end excluded from season but in lifetime; lifetimeStart fixed if season moves", () => {
  const tk = [
    { account: "@u", type: "receipt_check", effort: 1, date: "2026-11-08" }, // prelaunch
    { account: "@u", type: "receipt_check", effort: 2, date: "2026-11-09" }, // launch day
    { account: "@u", type: "receipt_check", effort: 3, date: "2026-11-22" },
    { account: "@u", type: "receipt_check", effort: 4, date: "2026-11-23" }, // season end (excluded from season)
    { account: "@u", type: "receipt_check", effort: 5, date: "2026-12-01" }  // after season 1
  ];
  const lifetimeStart = "2026-11-09";
  const sea = E.baseEnergy(tk, { from: "2026-11-09", to: "2026-11-23" });
  const life = E.baseEnergy(tk, { from: lifetimeStart, to: "2026-12-02" });
  eq(sea.get("@u"), E.taskEnergy(tk[1]) + E.taskEnergy(tk[2]));
  eq(life.get("@u"), E.taskEnergy(tk[1]) + E.taskEnergy(tk[2]) + E.taskEnergy(tk[3]) + E.taskEnergy(tk[4]));
  ok(!life.get("@u") || !tk.some(() => false));
  ok(!(E.baseEnergy(tk, { from: lifetimeStart, to: "2026-11-09" }).get("@u"))); // empty if asOf==start
  // future season bump moves season start; lifetimeStart stays fixed in HTML config
  ok(SEASON.lifetimeStart === "2026-11-18T12:00:00-05:00");
  const bumpedSeasonStart = "2026-12-07";
  const sea2 = E.baseEnergy(tk, { from: bumpedSeasonStart, to: "2026-12-21" });
  eq(sea2.get("@u"), undefined, "Dec 1 task is before a bumped Season 2 start");
  const lifeStill = E.baseEnergy(tk, { from: lifetimeStart, to: "2026-12-02" });
  eq(lifeStill.get("@u"), life.get("@u"), "lifetime unchanged when season window moves");
  // post-season2 activity still accrues to fixed lifetimeStart
  const lifeLater = E.baseEnergy(tk.concat([{ account: "@u", type: "receipt_check", effort: 6, date: "2026-12-10" }]), { from: lifetimeStart, to: "2026-12-11" });
  ok(lifeLater.get("@u") > life.get("@u"));
});

t("SEASON config: prize $600 paid in BNB, 300/200/100; Nov 18–Dec 9 noon ET; tasks drive TASK_WEIGHTS; offsets -05:00", () => {
  eq(SEASON.prizes.usdTotal, 600); eq(SEASON.prizes.usdSplit, [300,200,100]); eq(SEASON.prizes.payoutAsset, "BNB");
  eq(SEASON.prizes.usdSplit.reduce((a, b) => a + b, 0), SEASON.prizes.usdTotal);
  ok(!("bnbTotal" in SEASON.prizes) && !("usdIllustrativeBand" in SEASON.prizes), "no 1 BNB figure / $600–$700 band in config");
  eq(SEASON.start, "2026-11-18T12:00:00-05:00"); eq(SEASON.end, "2026-12-09T12:00:00-05:00"); eq(SEASON.lifetimeStart, SEASON.start);
  eq((toInstantMs(SEASON.end) - toInstantMs(SEASON.start)) / 864e5, 21, "three weeks");
  ok(SEASON.start.endsWith("-05:00") && SEASON.end.endsWith("-05:00") && SEASON.lifetimeStart.endsWith("-05:00"));
  for (const t of SEASON.tasks) eq(CONFIG.TASK_WEIGHTS[t.id], t.points);
  eq(CONFIG.TASK_WEIGHTS.receipt_check, 10); eq(CONFIG.TASK_WEIGHTS.architect_ship, 60);
});
t("toInstantMs / inHalfOpenWindow: date-only=noon-05; exact noon; 11:59:59; end exclusive", () => {
  const noon = toInstantMs("2026-11-18T12:00:00-05:00");
  eq(toInstantMs("2026-11-18"), noon);
  ok(inHalfOpenWindow("2026-11-18T12:00:00-05:00", SEASON.start, SEASON.end));
  ok(inHalfOpenWindow("2026-11-18T11:59:59-05:00", "2026-11-18T11:59:59-05:00", SEASON.end));
  ok(!inHalfOpenWindow("2026-11-18T11:59:59-05:00", SEASON.start, SEASON.end), "1 min before launch excluded from season");
  ok(inHalfOpenWindow("2026-11-18", SEASON.start, SEASON.end), "date-only launch day = noon included");
  ok(!inHalfOpenWindow("2026-12-09T12:00:00-05:00", SEASON.start, SEASON.end), "end exclusive");
  ok(inHalfOpenWindow("2026-12-09T11:59:59-05:00", SEASON.start, SEASON.end));
  // engine uses same helper
  const a = [{ account: "@u", handle: "u", seedUsd: 0 }];
  const tk = [
    { account: "@u", type: "receipt_check", effort: 1, date: "2026-11-18T11:59:59-05:00" },
    { account: "@u", type: "receipt_check", effort: 1, date: "2026-11-18T12:00:00-05:00" },
    { account: "@u", type: "receipt_check", effort: 1, date: "2026-12-09T11:59:59-05:00" },
    { account: "@u", type: "receipt_check", effort: 1, date: "2026-12-09T12:00:00-05:00" }
  ];
  const sea = E.baseEnergy(tk, { from: SEASON.start, to: SEASON.end });
  eq(sea.get("@u"), 20); // two tasks × 10
});
t("index: launch-clean copy (no sample/provisional wording), PRIZE_COPY, bar start copy, headstart +5, pager, no battery", () => {
  const h = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  ok(!/sample preview|Synthetic sample|provisional rules|Sample data/i.test(h), "no sample-preview / provisional visitor copy");
  ok(/PRIZE_COPY/.test(h) && !/usdIllustrative|bandHi|\b1 BNB\b/.test(h), "prize via PRIZE_COPY only; no 1 BNB / band");
  ok(/SEASON_WINDOW_COPY/.test(h) && /starts \$\{seasonStartShort\}/.test(h), "upcoming season window copy");
  ok(/counting begins/.test(h));
  ok(/\+5/.test(h) && /#11–20|#11-20/.test(h));
  ok(/PAGE_SIZE|data-pg/.test(h));
  ok(!/\bbatter(y|ies)\b/i.test(h));
  ok(/after Season 1 closes/.test(h));
  ok(/Local prototype — saved in this browser only/.test(h));
  ok(/from: LIFETIME_START,\s*to: ASOF/.test(h) || /from: LIFETIME_START/.test(h));
  ok(/PAGE_SIZE = 10/.test(h));
  ok(/not affiliated with Warner Bros\. or The Matrix films/.test(h), "non-affiliation footer");
});
// LEGACY prototype config (6 Nov: 10 referrer / 5 welcome) — the browser-local prototype is retired; kept for helper coverage.
const LEGACY_REF_SEASON = { ...SEASON, referral: { ...SEASON.referral, welcomeCredits: 5 } };
t("LEGACY referral prototype: canon/link, reject self/dup/unknown/roster; 10/5; pending before launch; lifetime-only raw; disable", () => {
  const mem = () => { let s=null; return { get:()=>s, set:v=>{s=v;} }; };
  const store = mem();
  const cfg = { ...LEGACY_REF_SEASON };
  eq(Ref.canonHandle(" @Sample_Syn_0001 "), "@sample_syn_0001");
  eq(Ref.encodeRef("@Ab_1"), "ab_1"); eq(Ref.decodeRef("Ab_1"), "@ab_1");
  ok(Ref.referralLink("https://onchain-matrix.github.io/onmx-gamification/", "@sample_syn_0103").endsWith("?ref=sample_syn_0103"));
  eq(Ref.registerReferral({ referrerRaw: "@nope", newRaw: "newbie1", rosterAccounts: ["@sample_syn_0103"], cfg, now: "2026-11-10T12:00:00-05:00", storeApi: store }).ok, false);
  eq(Ref.registerReferral({ referrerRaw: "@sample_syn_0103", newRaw: "sample_syn_0103", rosterAccounts: ["@sample_syn_0103"], cfg, now: "2026-11-10T12:00:00-05:00", storeApi: store }).ok, false);
  eq(Ref.registerReferral({ referrerRaw: "@sample_syn_0103", newRaw: "sample_syn_0001", rosterAccounts: ["@sample_syn_0103","@sample_syn_0001"], cfg, now: "2026-11-10T12:00:00-05:00", storeApi: store }).ok, false);
  const pre = Ref.registerReferral({ referrerRaw: "@sample_syn_0103", newRaw: "fresh_user1", rosterAccounts: ["@sample_syn_0103"], cfg, now: "2026-11-08T12:00:00-05:00", storeApi: store });
  eq(pre.ok, true); eq(pre.status, "pending"); eq(pre.referrerCredits, 10); eq(pre.welcomeCredits, 5);
  eq(Ref.lifetimeReferralRaw("@sample_syn_0103", store, 100), 0);
  eq(Ref.activatePending({ cfg, now: "2026-11-18T12:00:00-05:00", storeApi: store }).activated, 1);
  eq(Ref.statsFor("@sample_syn_0103", store).bonusCredits, 10);
  eq(Ref.lifetimeReferralRaw("@sample_syn_0103", store, 100), 1000);
  eq(Ref.lifetimeReferralRaw("@fresh_user1", store, 100), 500);
  eq(Ref.registerReferral({ referrerRaw: "@sample_syn_0103", newRaw: "fresh_user1", rosterAccounts: ["@sample_syn_0103"], cfg, now: "2026-11-10T12:00:00-05:00", storeApi: store }).ok, false, "dup");
  const store2 = mem();
  const off = { ...SEASON, referral: { ...SEASON.referral, enabled: false } };
  eq(Ref.registerReferral({ referrerRaw: "@sample_syn_0103", newRaw: "x", rosterAccounts: ["@sample_syn_0103"], cfg: off, now: "2026-11-10T12:00:00-05:00", storeApi: store2 }).ok, false);
});

t("season status boundaries + completed list only configured", () => {
  const s1 = SEASON_HISTORY[0];
  eq(seasonStatus(s1, toInstantMs("2026-11-18T11:59:59-05:00")), "upcoming");
  eq(seasonStatus(s1, toInstantMs("2026-11-18T12:00:00-05:00")), "active");
  eq(seasonStatus(s1, toInstantMs("2026-12-09T11:59:59-05:00")), "active");
  eq(seasonStatus(s1, toInstantMs("2026-12-09T12:00:00-05:00")), "completed");
  eq(completedSeasons(SEASON_HISTORY, toInstantMs("2026-11-05T12:00:00-05:00")).length, 0);
  eq(completedSeasons(SEASON_HISTORY, toInstantMs("2026-12-09T12:00:00-05:00")).map(s => s.number), [1]);
  ok(SEASON_HISTORY.every(s => s.number === 1), "no invented future seasons in config");
});
t("cumulative championship: S1=20 skip S2 => 20; S3 adds; empty fixtures ignored; referral excluded", () => {
  const hist = [
    { number: 1, start: "2026-11-09T12:00:00-05:00", end: "2026-11-23T12:00:00-05:00", results: [{ account: "@a", handle: "a", score: 100, seasonPoints: 20 }] },
    { number: 2, start: "2026-12-07T12:00:00-05:00", end: "2026-12-21T12:00:00-05:00", results: null },
    { number: 3, start: "2027-01-04T12:00:00-05:00", end: "2027-01-18T12:00:00-05:00", results: [{ account: "@a", handle: "a", score: 10, seasonPoints: 15 }, { account: "@c", handle: "c", score: 9, seasonPoints: 12 }] },
    { number: 4, start: "2027-02-01T12:00:00-05:00", end: "2027-02-14T12:00:00-05:00", results: [{ account: "@z", handle: "z", score: 0, seasonPoints: 0 }] }
  ];
  const mid = toInstantMs("2026-12-22T12:00:00-05:00");
  eq(cumulativeChampionship(hist, mid).map(r => [r.account, r.points]), [["@a", 20]]);
  const late = toInstantMs("2027-02-15T12:00:00-05:00");
  const stand = cumulativeChampionship(hist, late);
  eq(stand.find(r => r.account === "@a").points, 35);
  eq(stand.find(r => r.account === "@c").points, 12);
  ok(!stand.find(r => r.account === "@z"), "all-zero season ignored");
  ok(!stand.some(r => r.referralCredits), "no referral field");
});
t("index Results + Championship tabs; Treasury branch unchanged", () => {
  const h = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  ok(/data-t="results"/.test(h) && /cumulativeChampionship/.test(h));
  ok(/not_launched/.test(h) && /results appear after it closes/.test(h) && !/in progress — not final winners/.test(h));
  ok(/const cum = E\.cumulativeRaised\(tre\.inflows\)/.test(h));
  ok(/data-t="treasury"/.test(h));
});

t("PUBLIC_UI: not-live features gated off; PRIZE_COPY exact; LAUNCHED requires real data", () => {
  eq(PUBLIC_UI.liveData, false); eq(PUBLIC_UI.showTreasury, false); eq(PUBLIC_UI.showPrizeGrowth, false);
  eq(PUBLIC_UI.showReferral, false); eq(PUBLIC_UI.showAirdropConversion, false);
  eq(PRIZE_COPY, "Season 1 prize: $600 paid in BNB — $300 / $200 / $100 for the top 3.");
  ok(!/airdrop|1 BNB|700/i.test(PRIZE_COPY));
  const h = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  ok(/const LAUNCHED = LIVE && /.test(h), "live status requires real data");
  ok(/UI\.showTreasury/.test(h) && /UI\.showReferral/.test(h) && /UI\.showAirdropConversion/.test(h) && /UI\.showPrizeGrowth/.test(h));
  ok(/id="claimsApiPanel"[^>]*hidden/.test(h) && /claimsReady/.test(h), "claim panel hidden until X login configured");
  ok(!/decoder_implemented_grants_off|preview only/.test(h));
});
t("treasuryBuyPoints continuous exp-v1: cap 250, 2dp, finite", () => {
  eq(SEASON.treasuryBuy.formulaVersion, "exp-v1");
  eq(SEASON.treasuryBuy.capPoints, 250);
  eq(treasuryBuyPoints(0), 0);
  eq(treasuryBuyPoints(100), 23.79);
  eq(treasuryBuyPoints(1000), 158.03);
  eq(treasuryBuyPoints(10000), 249.99);
  eq(treasuryBuyPoints(1e12), 250);
  eq(proposedPrizeGrowthUsd(35000), 350);
});
t("treasury buy claim freeze + next-season queue; season cap 250", () => {
  const a = freezeTreasuryBuyClaim({ seasonNumber: 1, canonicalHandle: "@a", purchaseTxId: "0x1", amountUsd: 1000, purchaseAt: "2026-11-10" });
  eq(a.ok, true); eq(a.claim.pointsAtPurchase, 158.03);
  const locked = a.claim.pointsAtPurchase;
  const q = queueTreasuryBuyForNextSeason({ existingClaim: a.claim, nextSeasonNumber: 2, purchaseTxId: "0x2", amountUsd: 5000, purchaseAt: "2026-11-11" });
  eq(q.ok, true); eq(q.claim.season, 2);
  eq(a.claim.pointsAtPurchase, locked);
  eq(seasonBuyPointsTotal([a.claim, { ...a.claim, purchaseTxId: "extra", pointsAtPurchase: 200 }], "@a", 1), 250);
});
t("Treasury UI continuous formula + growth; verification not live; no old brackets", () => {
  eq(E.treasuryIndex(35000), 450);
  const h = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  ok(/Unitless recognition metric/.test(h));
  ok(/capPoints/.test(h) && /formulaVersion/.test(h));
  ok(/Proposed/.test(h) && /growth/.test(h));
  ok(/Purchase verification/.test(h));
  ok(!/treasuryBuy\.brackets/.test(h));
});
t("referral UI raw: no maxlength 15 truncation; self @sample_syn_0103 rejects; never silent @sample_syn_010", () => {
  const h = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  ok(/id="newh"[^>]*maxlength="64"/.test(h));
  ok(!/id="newh"[^>]*maxlength="15"/.test(h));
  ok(/\^@\?\[A-Za-z0-9_\]\{1,15\}\$/.test(h));
  const raw = "@sample_syn_0103";
  ok(raw.length === 16);
  ok(/^@?[A-Za-z0-9_]{1,15}$/.test(raw.trim()));
  eq(Ref.canonHandle(raw), "@sample_syn_0103");
  ok(Ref.canonHandle(raw) !== Ref.canonHandle("@sample_syn_010"));
  const mem = () => { let s=null; return { get:()=>s, set:v=>{s=v;} }; };
  const store = mem();
  eq(Ref.registerReferral({ referrerRaw: "@sample_syn_0103", newRaw: raw, rosterAccounts: ["@sample_syn_0103"], cfg: SEASON, now: "2026-11-10T12:00:00-05:00", storeApi: store }).ok, false);
  ok(!Ref.listLocalHandles(store).includes("@sample_syn_010"));
});
t("referral pending welcome on stats; launch activate 10/5 idempotent", () => {
  const mem = () => { let s=null; return { get:()=>s, set:v=>{s=v;} }; };
  const store = mem();
  const pre = Ref.registerReferral({ referrerRaw: "@sample_syn_0103", newRaw: "onmx_test_1105b", rosterAccounts: ["@sample_syn_0103"], cfg: LEGACY_REF_SEASON, now: "2026-11-05T12:00:00-05:00", storeApi: store });
  eq(pre.status, "pending");
  eq(Ref.statsFor("@onmx_test_1105b", store).asReferred.welcomeCredits, 5);
  eq(Ref.lifetimeReferralRaw("@onmx_test_1105b", store, 100), 0);
  eq(Ref.activatePending({ cfg: LEGACY_REF_SEASON, now: "2026-11-18T12:00:00-05:00", storeApi: store }).activated, 1);
  eq(Ref.activatePending({ cfg: LEGACY_REF_SEASON, now: "2026-11-19T12:00:00-05:00", storeApi: store }).activated, 0);
  eq(Ref.lifetimeReferralRaw("@sample_syn_0103", store, 100), 1000);
  eq(Ref.lifetimeReferralRaw("@onmx_test_1105b", store, 100), 500);
});

// --- Matrix Signals (PROPOSED credit table) + flags ---
t("Matrix Signals tasks replace the five legacy tasks; ids/labels/descriptions; points = accepted Credits × 100", () => {
  eq(SEASON.tasks.map(x => x.id), ["signal_reply", "signal_quote", "signal_connect", "signal_discover", "signal_standalone"]);
  for (const x of SEASON.tasks) { ok(x.desc && x.desc.length > 40 && x.desc.length < 240, "desc " + x.id); eq(x.points, SIGNALS.baseCredits[x.id.replace("signal_", "")] * CONFIG.POINTS_PER_BATTERY); }
  eq(SEASON.legacyTasks.map(x => x.id), ["receipt_check", "verifier_checklist", "architect_ship", "circle_onboard", "video_watch"]);
  ok(!/\bfollow (us|@|for)|retweet|repost for|like for/i.test(SEASON.tasks.map(x => x.desc).join(" ")), "no follow/retweet-for-points tasks");
  eq(SIGNALS.status, "approved");
});
t("signalCredits: type × tier + capped outcome bonus; unknown/rejected = 0", () => {
  eq(signalCredits("reply", "accepted"), 5); eq(signalCredits("reply", "strong"), 10); eq(signalCredits("reply", "outstanding"), 20);
  eq(signalCredits("quote", "accepted"), 4); eq(signalCredits("connect", "outstanding"), 24); eq(signalCredits("standalone", "accepted"), 2);
  eq(signalCredits("reply", "accepted", { kolReplied: true }), 10);
  eq(signalCredits("discover", "accepted", { kolReplied: true, kolFollowed: true, directInterest: true, introduction: true }), 6 + 25);
  eq(signalCredits("reply", "spam"), 0); eq(signalCredits("follow", "accepted"), 0);
});
t("signalToTask feeds the existing engine: approved strong reply = 1000 pts = 10 Credits; pending/rejected ignored", () => {
  const rows = [
    signalToTask({ account: "@a", type: "reply", tier: "strong", date: "2026-11-19T10:00:00-05:00", status: "approved" }),
    signalToTask({ account: "@a", type: "quote", tier: "accepted", date: "2026-11-19T11:00:00-05:00", status: "pending" }),
    signalToTask({ account: "@b", type: "standalone", tier: "accepted", date: "2026-11-19T11:00:00-05:00", status: "rejected" })
  ].filter(Boolean);
  eq(rows.length, 1);
  const b = E.baseEnergy(rows, { from: SEASON.start, to: SEASON.end });
  eq(b.get("@a"), 1000); eq(b.get("@a") / CONFIG.POINTS_PER_BATTERY, 10);
});
t("referral: legacy % model marked legacy; flat server model 10/5, cap 20, qualifies on first approved signal", () => {
  eq(CONFIG.REFERRAL.legacy, true);
  eq(CONFIG.REFERRAL_FLAT, { l1Credits: 10, l2Credits: 5, capQualifiedPerSeason: 20, qualifyOn: "first_approved_signal", scope: "lifetime_only" });
  eq(SEASON.referral.referrerCredits, 10); eq(SEASON.referral.level2Credits, 5); eq(SEASON.referral.capQualifiedPerSeason, 20);
});
t("PUBLIC_UI: signals + referral ON (owner approved Nov 13 2026); legacy local referral OFF", () => {
  eq(PUBLIC_UI.signals, true); eq(PUBLIC_UI.referral, true); eq(PUBLIC_UI.showReferral, false); // owner approved Nov 13 2026
});
t("Worker signal policy mirrors src/config.js SIGNALS", () => {
  const w = readFileSync(new URL("../worker/src/signals/policy.js", import.meta.url), "utf8");
  ok(w.includes("baseCredits: Object.freeze({ reply: 5, quote: 4, connect: 6, discover: 6, standalone: 2 })"), "base");
  ok(w.includes("tierMultiplier: Object.freeze({ accepted: 1, strong: 2, outstanding: 4 })"), "tiers");
  ok(w.includes("outcomeBonus: Object.freeze({ kolReplied: 5, kolFollowed: 3, directInterest: 5, introduction: 15 })"), "bonus");
  ok(w.includes("bonusCapPerSignal: 25") && w.includes("l1Credits: 10") && w.includes("l2Credits: 5") && w.includes("capQualifiedPerSeason: 20"), "caps");
});

t("S9 wiring: season board/search use /v1/leaderboard only when signals flag or owner preview is on", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const ui = readFileSync(new URL("../src/signals-ui.js", import.meta.url), "utf8");
  ok(/let SIGBOARD = null/.test(html), "SIGBOARD starts null (public board unchanged)");
  const boot = html.slice(html.indexOf("async function bootSignals"), html.indexOf("// Optional seed-claim client"));
  ok(/if \(sigOn\) \{[\s\S]*SIGBOARD = await SG\.fetchLeaderboard/.test(boot), "SIGBOARD set only inside bootSignals when sigOn");
  ok((html.match(/SIGBOARD = /g) || []).length === 3, "SIGBOARD assigned only in boot (+ error fallback)");
  ok(/if \(UI\.signals \|\| UI\.referral\)/.test(boot) && /get\("preview"\) === "signals"/.test(boot), "boot gated by flags or ?preview=signals");
  ok(ui.includes("/v1/leaderboard?"), "client calls /v1/leaderboard");
  ok(!/headStart|HEADSTART/.test(ui), "head-start rules stay back-end only");
});

const summary = { total: results.length, passed: results.filter(r => r.pass).length, failed: results.filter(r => !r.pass).length, engine: CONFIG.version };
writeFileSync(new URL("./results.json", import.meta.url), JSON.stringify({ summary, results }, null, 1));
console.log(JSON.stringify(summary)); for (const r of results) if (!r.pass) console.log("FAIL", r.name, r.error);
process.exit(summary.failed ? 1 : 0);
