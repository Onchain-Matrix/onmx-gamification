# onmx-gamification — PRIVATE DRAFT (owner review only, do not publish)

Static, GitHub-Pages-*compatible* contributor leaderboard + dry-run simulation for the ONMX gamification program.
**Not deployed. Pages is not enabled. Actions is disabled. No live data.**

> ⚠️ **No existing production scoring logic was found** (read-only check of the OnchainNeo GitHub account — no repos — and the local workspace).
> `src/engine.js` is **new, provisional, unapproved logic** written from the Notion brainstorm/sketch. Every number in `src/config.js` is an assumption.
> No real money, token conversion, or public reward commitment is implied anywhere.

## Contents
| Path | What |
|---|---|
| `index.html` | Dashboard: ranks 1–100, X link, score, classification, recognition reward, gap to #1 / person ahead / chosen target rank + next step; separate **championship standings** (F1 points) and **race results** tabs; treasury index tab. Runs `src/engine.js` in the browser. |
| `src/engine.js` | The single shared scoring engine (dashboard **and** simulation import this same file). |
| `src/config.js`, `assumptions.json` | Provisional parameters (assumptions, commented). |
| `data/sample-*.json` | **SYNTHETIC** fake accounts (`sample_syn_####`), tasks, inflows, races. Not real members. |
| `tools/export-roster.mjs` | Offline roster exporter interface (no network, no credentials). Refuses to run while visibility policy is `UNDECIDED`. Notion fetch is a stub. |
| `ops/daily-update.workflow.yml.disabled` | Daily bot update **designed but inactive** (not in `.github/workflows/`, no schedule, no deploy step). |
| `tests/run.mjs` → `tests/results.json`, `tests/run-output.txt` | Seeded unit tests. |
| `sim/run.mjs` → `sim/output.json`, `SIMULATION_REPORT.md` | Dry-run scenarios. |

Run: `node tests/run.mjs && node sim/run.mjs` (Node ≥ 18, no dependencies). Preview: `python3 -m http.server` then open `/`.

## Model (provisional)
- **Energy** from real contribution tasks (`TASK_WEIGHTS`); effort ≤ 0 ⇒ 0. No follows/RTs/joins scored.
- **Final = Energy × Seed band multiplier** (bands $10/$1k/$10k/$100k from brainstorm; multipliers are placeholders). 0 energy ⇒ 0.
- **Races** (14 days assumed) score own energy × multiplier + bounded **head start** (winner: min(5% of own prior-race score, 50); Seed: +20; total cap 60; next race only; 0 if no own effort).
- **Championship** = F1 points (25-18-15-12-10-8-6-4-2-1) summed across races. Shown separately from race standings.
- **Referrals**: one referrer, binds once; self/duplicate/cycle rejected; 10% L1 / 5% L2 of referee's *base* energy; no L3+; **airdrop-only** — never race/championship, never Seed-amplified; credit unlocks 50% at day 30 and 50% at day 60 only if referee still active.
- **Decay**: hoarded balance −2%/day after 7 idle days. (Implemented and tested; leaderboard currently ranks *earned* energy — whether decay hits rank is OPEN.)
- **Treasury index**: f(**cumulative raised** = sum of positive inflows), never wallet balance; floor 100, +1% of cumulative raised, cap 100,000; unitless.

## Open decisions / assumptions (NOT final)
1. Visibility: everyone vs opt-in — **unresolved**; exporter blocks.
2. All weights, multipliers, head-start sizes, decay rate, gate split, F1 table, class thresholds, treasury curve.
3. Race length (14 d) and count (10).
4. Whether decay applies to rank or only to spendable balance; whether energy is "spent" on races.
5. Whether `seedUsd` may be stored in the roster at all (used only for band; never displayed).
6. Tie-break: earlier Verifier date, then handle (from sketch).
7. Sample handles `sample_syn_####` link to x.com and could theoretically match real accounts — replace before any non-private use.
