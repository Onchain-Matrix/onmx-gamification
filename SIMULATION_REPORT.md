# Simulation report — DRY RUN, SYNTHETIC DATA (provisional unapproved engine)

Seed 20261105 · engine `src/engine.js` (same file the dashboard runs) · raw output `sim/output.json`, tests `tests/results.json`.
**Synthetic returns test the pipeline only. Nothing here is a conclusion about real human behaviour, and no fake retention result identifies a real "winning" design.**

## Final results
- Unit tests: **27 / 27 pass**.
- Scenarios: **9 / 9 pass** (after fixes below).

| # | Scenario | Key metrics | Pass condition | Result |
|---|---|---|---|---|
| S1 | 10 races × 14 d, 300 fake accounts | 6 distinct winners, max 2 consecutive wins, 0 head-start-decided wins, max head start 4.65% of winner score | ≤2 head-start-decided wins; head start ≤60; champ pts = Σ race pts | PASS |
| S2 | KOL + 100k direct fake referrals (8% synthetic retention) | referral energy day0 = 0, day30 = 3,967, day60 = 7,934 (airdrop only); KOL wins R1 (own 180), R2 rank 2 (10 + 9 head start) vs grinder 120; runtime ≈0.55 s | 0 before gate; race excludes referral; no repeat win vs higher-effort player; <10 s | PASS |
| S3 | depth-10 sybil chain + cycle + self + duplicate | only S9 (L1) & S8 (L2) paid, total 150 = 15% | no L3+; all abuse rejected | PASS |
| S4 | Seed vs effort | 0 effort + $1M Seed = 0; free needs >2× energy to beat max band (+20 head start in races) | 0⇒0; bonus never replaces effort | PASS |
| S5 | decay of 1,000 hoarded | 7d 1000 · 14d 868 · 30d 628 · 60d 343 · 90d 187 | monotonic, ≥0 | PASS |
| S6 | treasury curve | 0/neg ⇒ 100; +50k −40k ⇒ 600 (outflow ignored); $1M ⇒ 10,100; cap 100,000 at $9.99M | floor/cap/cumulative-only | PASS |
| S7 | badge cohorts (visible vs ranks-only), n=4000 | null: diff −0.0044 CI[−0.029, 0.020]; injected +0.05: diff 0.0635 CI[0.037, 0.090] | null CI ∋ 0; injected recovered; balanced | PASS (pipeline only) |
| S8 | reproducibility | sha256 5659a983… identical twice | identical | PASS |
| S9 | class calibration on sample board | Architect 2 · Node 7 · Verifier 44 · Signal 47 | no class >60% | PASS after fix |

## Bugs found → fixed → rerun
- **BUG-1** (unit test "head start bounded and next-race-only", first run 26/27): head start was computed from the previous winner's score *including* its own head start, so head starts could compound race-to-race. Fixed: use pre-head-start `own` score. Rerun 27/27.
- **BUG-2** (scenario S9, first run 8/9): class thresholds 400/250/150 put 76/100 sample rows in "Architect". Recalibrated to 2000/1200/600 (still provisional). Rerun 9/9.

## Incentive misalignments / residual risks
1. **Referral airdrop concentration**: a KOL with 100k referees accrues ~7.9k airdrop energy at 8% retention — ≈40× his own race energy. Excluded from championship by design, but dominates the airdrop side; consider a cap.
2. **Seed 2× band**: a max-band holder ties a free player with 2× the effort, plus a flat 20-pt race head start. "Never required to win" holds only above that ratio.
3. **Treasury index cap** reached at $9.99M cumulative raised; curve is linear and saturates — "oh shit" scaling not designed; any $/token reading of the index would be a public-commitment risk.
4. **Absolute class thresholds on cumulative score** drift as time passes (everyone eventually becomes Architect). Percentile or rolling-window classes are an open choice.
5. **Decay not applied to rank** (only to balances) — hoarders keep rank. Open decision.
6. **KOL R1 win** is still possible on own effort; only the *repeat* is blocked, and only because the referral audience isn't counted.
7. Gate depends on accurate `lastActive`; sybil activity farming at day 30/60 is not detected here.
8. Head-start-decided wins = 0 at these settings: the head start may be too small to matter ("iterate on return").
9. Badge test uses an injected effect; real effect sizes are unknown and need a real, consented experiment.
