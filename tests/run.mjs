// Deterministic tests for the shared engine (src/engine.js). Writes tests/results.json.
import { writeFileSync } from "node:fs";
import * as E from "../src/engine.js";
import { CONFIG } from "../src/config.js";
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
t("head start bounded and next-race-only", () => { eq(E.headStart({ wonPrev: true, prevWinScore: 1e9, seedUsd: 0 }), 50); eq(E.headStart({ wonPrev: true, prevWinScore: 1e9, seedUsd: 1e6 }), 60); eq(E.headStart({ wonPrev: false, seedUsd: 0 }), 0);
  const accounts = [acc("A"), acc("B")]; const races = [1, 2, 3].map(i => ({ id: "R" + i, from: `2026-10-${String(i * 10 - 9).padStart(2, "0")}`, to: `2026-10-${String(i * 10 + 1).padStart(2, "0")}` }));
  const tasks = [{ account: "A", type: "architect_ship", effort: 10, date: "2026-10-02" }, { account: "A", type: "receipt_check", effort: 1, date: "2026-10-12" }, { account: "B", type: "receipt_check", effort: 1, date: "2026-10-12" },
    { account: "A", type: "receipt_check", effort: 1, date: "2026-10-22" }, { account: "B", type: "receipt_check", effort: 1, date: "2026-10-22" }];
  const c = E.championship(races, tasks, accounts); eq(c.results[1].rows.find(r => r.account === "A").headStart, 30); eq(c.results[2].rows.find(r => r.account === "A").headStart, 0.5, "R3 head start = 5% of R2 OWN score (10), not of score incl. head start (BUG-1)"); });
t("head start zero when no own effort (never a free win)", () => { const rows = E.scoreRace({ id: "R", from: "2026-10-01", to: "2026-10-15" }, [], [acc("A", 1e6)], { account: "A", own: 1000, score: 1000 }); eq(rows[0].score, 0); eq(rows[0].points, 0); });
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
import { readFileSync } from "node:fs";
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

const summary = { total: results.length, passed: results.filter(r => r.pass).length, failed: results.filter(r => !r.pass).length, engine: CONFIG.version };
writeFileSync(new URL("./results.json", import.meta.url), JSON.stringify({ summary, results }, null, 1));
console.log(JSON.stringify(summary)); for (const r of results) if (!r.pass) console.log("FAIL", r.name, r.error);
process.exit(summary.failed ? 1 : 0);
