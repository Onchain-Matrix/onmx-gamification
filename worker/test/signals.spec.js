import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { createWorker } from "../src/index.js";
import { applyMigrations } from "./apply-migrations.js";
import { validateSubmission, parseStatusUrl, signalBaseCredits, signalBonusCredits, SIGNAL_POLICY, REFERRAL_POLICY, referralL1Points, referralL2Points, capReferralGrant, currentTimeMs, isSeasonStarted, seasonStartMs, seasonEndMs, POLICY, toInstantMs } from "../src/signals/policy.js";
import { grantReferralShares } from "../src/signals/handlers.js";


const ORIGIN = "https://onchain-matrix.github.io";
const ADMIN = "test-admin-token-0123456789abcdef";
const worker = createWorker();
let seq = 0;
const sid = () => String(1900000000000000000n + BigInt(++seq) * 7919n);

// Injectable clock. Default to the season start so existing approval tests still grant points
// (wall-clock now is before launch). Production uses Date.now() via currentTimeMs().
const START_MS = seasonStartMs();
const END_MS = seasonEndMs();
const clock = { nowMs: START_MS };

function envAt(ms = clock.nowMs) {
  return Object.assign(Object.create(env), { nowMs: () => ms });
}

async function call(path, { method = "GET", body, headers = {}, nowMs } = {}) {
  const h = { Origin: ORIGIN, ...headers };
  if (body !== undefined) h["Content-Type"] = "application/json";
  const req = new Request("https://onmx-gamification-claims.onmx.workers.dev" + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, envAt(nowMs ?? clock.nowMs), ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}
const preview = { "X-Admin-Preview": ADMIN };
const admin = { Authorization: "Bearer " + ADMIN };
async function register(handle, ref, extra = {}) {
  return call("/v1/signals/register", { method: "POST", body: { handle, ref }, headers: { ...preview, ...extra } });
}
async function submit(key, handle, over = {}) {
  return call("/v1/signals", { method: "POST", headers: { ...preview, "X-Player-Key": key }, body: {
    type: "reply", topic: "rwa", why: "Thread on RWA allocation; added a treasury allocation question.",
    signalUrl: `https://x.com/${handle}/status/${sid()}`, targetUrl: `https://x.com/BNBCHAIN/status/${sid()}`, onmxMentioned: true, ...over } });
}
async function approve(id, tier = "accepted", outcomes = {}) {
  return call(`/v1/admin/signals/${id}/approve`, { method: "POST", headers: admin, body: { tier, outcomes } });
}
async function ledger(playerId) {
  return (await env.DB.prepare(`SELECT kind, credits, label FROM credit_ledger WHERE player_id = ? ORDER BY kind`).bind(playerId).all()).results;
}

beforeAll(async () => { await applyMigrations(env.DB); });

describe("signals policy (pure)", () => {
  it("credit table: type x tier, outcome bonus capped, unknown = 0", () => {
    expect(signalBaseCredits("reply", "accepted")).toBe(5);
    expect(signalBaseCredits("reply", "outstanding")).toBe(20);
    expect(signalBaseCredits("standalone", "strong")).toBe(4);
    expect(signalBaseCredits("connect", "nope")).toBe(0);
    expect(signalBonusCredits({ kolReplied: true, kolFollowed: true, directInterest: true, introduction: true })).toBe(SIGNAL_POLICY.bonusCapPerSignal);
    expect(signalBonusCredits({ kolReplied: "yes" })).toBe(0);
    expect(REFERRAL_POLICY.version).toBe("referral-pct-v1");
    expect(REFERRAL_POLICY.welcomeCredits).toBe(0);
    expect(REFERRAL_POLICY.capPointsPerSeason).toBe(250000);
    expect(REFERRAL_POLICY.l1Percent).toBe(5);
    expect(REFERRAL_POLICY.l2Percent).toBe(2.5);
    for (const [pts, l1, l2] of [[5, 0.25, 0.125], [3, 0.15, 0.075], [10, 0.5, 0.25], [20, 1, 0.5], [2, 0.1, 0.05], [0, 0, 0], [-4, 0, 0]]) {
      expect(referralL1Points(pts)).toBe(l1);
      expect(referralL2Points(pts)).toBe(l2);
    }
    expect(capReferralGrant(0.25, 0)).toBe(0.25);
    expect(capReferralGrant(0.25, 249999.9)).toBe(0.1);
    expect(capReferralGrant(0.25, 250000)).toBe(0);
    expect(capReferralGrant(0.25, 260000)).toBe(0);
  });
  it("season dates come from policy.js; start is inclusive; clock is injectable", () => {
    expect(POLICY.seasonStart).toBe("2026-11-25T18:00:00-05:00");
    expect(POLICY.seasonEnd).toBe("2026-12-09T12:00:00-05:00");
    expect(START_MS).toBe(toInstantMs(POLICY.seasonStart));
    expect(START_MS).toBe(Date.parse("2026-11-25T23:00:00Z"));
    expect(isSeasonStarted(START_MS - 1)).toBe(false);
    expect(isSeasonStarted(START_MS)).toBe(true);
    expect(isSeasonStarted(START_MS + 1)).toBe(true);
    expect(isSeasonStarted(END_MS)).toBe(true); // no end-of-season grant block today
    const fake = { nowMs: () => START_MS - 1 };
    expect(currentTimeMs(fake)).toBe(START_MS - 1);
    expect(currentTimeMs({ NOW_MS: String(START_MS) })).toBe(START_MS);
  });
  it("URL validation: x.com/twitter.com status only; author must be the player; discover target may be a profile", () => {
    expect(parseStatusUrl("https://twitter.com/Alice_1/status/123456789?s=20").url).toBe("https://x.com/Alice_1/status/123456789");
    expect(parseStatusUrl("https://x.com.evil.io/a/status/123456")).toBeNull();
    expect(parseStatusUrl("https://x.com/i/status/123456")).toBeNull();
    expect(parseStatusUrl("javascript:alert(1)")).toBeNull();
    const base = { type: "reply", topic: "bnb", why: "Useful thesis on BNB treasury allocation." };
    expect(validateSubmission({ ...base, signalUrl: "https://x.com/bob/status/111111", targetUrl: "https://x.com/cz_binance/status/222222" }, "alice").error).toBe("signal_not_by_player");
    expect(validateSubmission({ ...base, signalUrl: "https://x.com/alice/status/111111" }, "alice").error).toBe("target_required");
    expect(validateSubmission({ ...base, why: "short", signalUrl: "https://x.com/alice/status/111111", targetUrl: "https://x.com/cz/status/2222222" }, "alice").error).toBe("invalid_why");
    expect(validateSubmission({ ...base, type: "zealy" }, "alice").error).toBe("invalid_type");
    expect(validateSubmission({ ...base, type: "discover", targetUrl: "https://x.com/OndoFinance" }, "alice").ok).toBe(true);
    expect(validateSubmission({ ...base, type: "reply", signalUrl: "https://x.com/alice/status/111111", targetUrl: "https://x.com/OndoFinance" }, "alice").error).toBe("invalid_target_url");
  });
});

describe("signals API", () => {
  it("closed by default: player endpoints 503 without admin preview; /v1/config advertises signals.open=false", async () => {
    const r = await call("/v1/signals/register", { method: "POST", body: { handle: "nobody1" } });
    expect(r.status).toBe(503);
    expect(r.json.error).toBe("signals_not_open");
    const bad = await call("/v1/signals/register", { method: "POST", body: { handle: "nobody1" }, headers: { "X-Admin-Preview": "wrong-token" } });
    expect(bad.status).toBe(503);
    const cfg = await call("/v1/config");
    expect(cfg.status).toBe(200);
    expect(cfg.json.signals.open).toBe(false);
    expect(cfg.json.readiness).toBeTruthy(); // existing config keys still present
  });

  it("register → submit → pending; credits never self-awarded; dedupe + per-target + daily limit", async () => {
    const reg = await register("alice_sig");
    expect(reg.status).toBe(200);
    expect(reg.json.playerKey).toMatch(/^onmxp_/);
    expect(reg.json.refCode).toMatch(/^[A-Z0-9]{8}$/);
    const key = reg.json.playerKey;
    const dupReg = await register("ALICE_SIG");
    expect(dupReg.status).toBe(409);

    const s1 = await submit(key, "alice_sig", { credits: 999, status: "approved", tier: "outstanding" });
    expect(s1.status).toBe(200);
    expect(s1.json.status).toBe("pending");
    const me = await call("/v1/signals/me", { headers: { ...preview, "X-Player-Key": key } });
    expect(me.json.signals[0].status).toBe("pending");
    expect(me.json.credits.seasonSignal).toBe(0);
    expect((await ledger(reg.json.playerId)).length).toBe(0);

    const row = await env.DB.prepare(`SELECT signal_url, target_url FROM signals WHERE id = ?`).bind(s1.json.id).first();
    const dup = await call("/v1/signals", { method: "POST", headers: { ...preview, "X-Player-Key": key }, body: { type: "quote", topic: "rwa", why: "Same post resubmitted as quote.", signalUrl: row.signal_url.replace("x.com", "twitter.com"), targetUrl: `https://x.com/OndoFinance/status/${sid()}` } });
    expect(dup.status).toBe(409);
    expect(dup.json.error).toBe("duplicate_signal");
    const dupT = await submit(key, "alice_sig", { targetUrl: row.target_url });
    expect(dupT.status).toBe(409);
    expect(dupT.json.error).toBe("duplicate_target");

    for (let i = 0; i < 4; i++) expect((await submit(key, "alice_sig")).status).toBe(200);
    const sixth = await submit(key, "alice_sig");
    expect(sixth.status).toBe(429);
    expect(sixth.json.error).toBe("daily_limit");

    const noKey = await call("/v1/signals", { method: "POST", headers: preview, body: {} });
    expect(noKey.status).toBe(401);
  });

  it("admin auth required; approve grants labeled Credits by tier + outcome bonus; reject with reason grants 0", async () => {
    const reg = await register("bob_sig");
    const key = reg.json.playerKey;
    const a = await submit(key, "bob_sig");
    const b = await submit(key, "bob_sig", { type: "quote" });
    expect((await call("/v1/admin/signals")).status).toBe(401);
    expect((await call(`/v1/admin/signals/${a.json.id}/approve`, { method: "POST", headers: { Authorization: "Bearer nope" }, body: { tier: "strong" } })).status).toBe(401);

    const list = await call("/v1/admin/signals?status=pending", { headers: admin });
    expect(list.status).toBe(200);
    expect(list.json.signals.some((s) => s.id === a.json.id && s.handle === "@bob_sig")).toBe(true);

    const ap = await approve(a.json.id, "strong", { kolReplied: true, impressions: 1200, repliesGenerated: 4, likes: 9 });
    expect(ap.status).toBe(200);
    expect(ap.json.baseCredits).toBe(10);
    expect(ap.json.bonusCredits).toBe(5);
    expect((await approve(a.json.id, "strong")).status).toBe(409); // idempotent: no double grant

    expect((await call(`/v1/admin/signals/${b.json.id}/reject`, { method: "POST", headers: admin, body: {} })).status).toBe(400);
    const rj = await call(`/v1/admin/signals/${b.json.id}/reject`, { method: "POST", headers: admin, body: { reason: "Generic mention, no contribution" } });
    expect(rj.status).toBe(200);

    const l = await ledger(reg.json.playerId);
    expect(l.map((x) => [x.kind, x.credits])).toEqual([["signal", 10], ["signal_bonus", 5]]);
    expect(l[0].label).toContain("Matrix Signal");
    const me = await call("/v1/signals/me", { headers: { ...preview, "X-Player-Key": key } });
    expect(me.json.credits.seasonSignal).toBe(15);
    expect(me.json.signals.find((s) => s.id === b.json.id).rejectReason).toContain("Generic");

    const out = await call(`/v1/admin/signals/${a.json.id}/outcomes`, { method: "POST", headers: admin, body: { outcomes: { kolReplied: true, introduction: true } } });
    expect(out.json.bonusCredits).toBe(20);
    const csv = await call("/v1/admin/signals.csv", { headers: admin });
    expect(csv.status).toBe(200);
    const head = csv.text.split("\r\n")[0];
    expect(head).toBe("Date,Contributor,X Handle,Target Account,Target Post URL,Signal URL,Signal Type,Topic,ONMX Mentioned?,Why Relevant,Quality,Impressions,Replies Generated,Likes,KOL Replied?,KOL Followed?,Outcome / Notes,Reward Status");
    expect(csv.text).toContain("Approved: 30 Credits");
    expect(csv.text).toContain("Rejected: Generic mention");
  });

  it("referral-pct-v1: inviter earns 5% and inviter's inviter 2.5% of every approved signal's points (?ref= codes)", async () => {
    const top = await register("ref_top");
    const mid = await register("ref_mid", top.json.refCode);
    expect(mid.json.referral.status).toBe("pending");
    expect(mid.json.referral.referrer).toBe("@ref_top");
    expect(mid.json.referral.via).toBe("code");
    const m1 = await submit(mid.json.playerKey, "ref_mid");
    const new1 = await register("ref_new", mid.json.refCode);
    const n1 = await submit(new1.json.playerKey, "ref_new");
    const n2 = await submit(new1.json.playerKey, "ref_new");

    let meMid = await call("/v1/signals/me", { headers: { ...preview, "X-Player-Key": mid.json.playerKey } });
    expect(meMid.json.referrals.pending).toBe(1);
    expect(meMid.json.referrals.qualified).toBe(0);
    expect(meMid.json.referrals.cap).toBe(250000);
    expect((await ledger(mid.json.playerId)).length).toBe(0); // no credit for a signup alone

    // rejection pays nothing
    await call(`/v1/admin/signals/${n1.json.id}/reject`, { method: "POST", headers: admin, body: { reason: "spam reply" } });
    expect((await ledger(mid.json.playerId)).length).toBe(0);

    // mid's own approved reply (5 points) → top earns 5% = 0.25 (mid has no level-2 above top)
    const apm = await approve(m1.json.id);
    expect(apm.json.referral.grants).toEqual([{ kind: "referral_l1", credits: 0.25, share: 0.25, capped: false }]);
    expect((await ledger(top.json.playerId)).find((x) => x.kind === "referral_l1").credits).toBe(0.25);

    // ref_new's reply + KOL replied bonus = 10 points → mid 5% = 0.5, top 2.5% = 0.25
    const ap = await approve(n2.json.id, "accepted", { kolReplied: true });
    expect(ap.json.referral.status).toBe("granted");
    expect(ap.json.referral.grants).toEqual([
      { kind: "referral_l1", credits: 0.5, share: 0.5, capped: false },
      { kind: "referral_l2", credits: 0.25, share: 0.25, capped: false },
    ]);
    let lt = await ledger(top.json.playerId);
    expect(lt.filter((x) => x.kind === "referral_l2").map((x) => x.credits)).toEqual([0.25]);
    meMid = await call("/v1/signals/me", { headers: { ...preview, "X-Player-Key": mid.json.playerKey } });
    expect(meMid.json.referrals.qualified).toBe(1);
    expect(meMid.json.referrals.pending).toBe(0);
    expect(meMid.json.referrals.l1Credits).toBe(0.5);
    expect(meMid.json.referrals.seasonPoints).toBe(0.5);

    // every later approval pays again (not just the first)
    const n3 = await submit(new1.json.playerKey, "ref_new");
    const ap3 = await approve(n3.json.id, "strong"); // 10 points
    expect(ap3.json.referral.grants.map((g) => g.credits)).toEqual([0.5, 0.25]);
    expect((await ledger(mid.json.playerId)).filter((x) => x.kind === "referral_l1").map((x) => x.credits).sort()).toEqual([0.5, 0.5]);

    // outcome update recomputes the shares for that signal (bonus removed → 5 points → 0.25 / 0.125)
    const out = await call(`/v1/admin/signals/${n2.json.id}/outcomes`, { method: "POST", headers: admin, body: { outcomes: {} } });
    expect(out.json.referral.grants.map((g) => g.credits)).toEqual([0.25, 0.125]);
    const rowsN2 = (await env.DB.prepare(`SELECT kind, credits FROM credit_ledger WHERE source_id = ? AND kind LIKE 'referral_%' ORDER BY kind`).bind(n2.json.id).all()).results;
    expect(rowsN2).toEqual([{ kind: "referral_l1", credits: 0.25 }, { kind: "referral_l2", credits: 0.125 }]);

    // revoke removes that signal's referral rows; referral stays qualified via the other approved signal
    const rv = await call(`/v1/admin/signals/${n2.json.id}/revoke`, { method: "POST", headers: admin, body: { reason: "found to be copy/paste" } });
    expect(rv.json.referralReset).toBe(true);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM credit_ledger WHERE source_id = ?`).bind(n2.json.id).first()).n).toBe(0);
    const ref = await env.DB.prepare(`SELECT status, qualifying_signal_id FROM referrals WHERE referred_id = ?`).bind(new1.json.playerId).first();
    expect(ref).toEqual({ status: "qualified", qualifying_signal_id: n3.json.id });
    lt = await ledger(top.json.playerId);
    expect(lt.filter((x) => x.kind === "referral_l2").map((x) => x.credits)).toEqual([0.25]); // only n3's share left
  });

  it("self-referral blocked; referrer immutable; unknown code ignored", async () => {
    const a = await register("self_a");
    const selfTry = await register("self_b", a.json.refCode, { "X-Player-Key": a.json.playerKey });
    expect(selfTry.status).toBe(400);
    expect(selfTry.json.error).toBe("self_referral");
    const sameHandle = await register("self_a", a.json.refCode);
    expect(sameHandle.status).toBe(409);
    const unk = await register("self_c", "ZZZZZZZZ");
    expect(unk.status).toBe(200);
    expect(unk.json.referral.status).toBe("ignored");
    // no endpoint can change a referrer after registration
    const again = await register("self_c", a.json.refCode);
    expect(again.status).toBe(409);
    const row = await env.DB.prepare(`SELECT referrer_id FROM signal_players WHERE id = ?`).bind(unk.json.playerId).first();
    expect(row.referrer_id).toBeNull();
    const res = await call(`/v1/referral/resolve?code=${a.json.refCode}`);
    expect(res.json).toEqual({ ok: true, valid: true, referrer: "@self_a" });
  });

  it("cap: 250,000 referral points per account per season — a grant is cut to the room left, then 0", async () => {
    const r = await register("cap_ref");
    const rid = r.json.playerId;
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO credit_ledger (id, player_id, season, kind, credits, label, source_id, created_at) VALUES (?, ?, 1, 'referral_l1', ?, 'seed', 'seed-src-1', ?)`).bind("seedcap1", rid, 249999.9, now).run();
    const n = await register("cap_new", r.json.refCode);
    const s1 = await submit(n.json.playerKey, "cap_new");
    const ap = await approve(s1.json.id); // 5 points → share 0.25, room 0.1
    expect(ap.json.referral.grants).toEqual([{ kind: "referral_l1", credits: 0.1, share: 0.25, capped: true }]);
    const s2 = await submit(n.json.playerKey, "cap_new");
    const ap2 = await approve(s2.json.id);
    expect(ap2.json.referral.grants).toEqual([{ kind: "referral_l1", credits: 0, share: 0.25, capped: true }]);
    const total = await env.DB.prepare(`SELECT SUM(credits) AS c, COUNT(*) AS n FROM credit_ledger WHERE player_id = ? AND kind LIKE 'referral_%'`).bind(rid).first();
    expect(total.n).toBe(2);
    expect(Math.round(total.c * 1e6) / 1e6).toBe(250000);
  });

  it("/referral/<handle>: 302 to the join page with a signed 30-day token + cookie; unknown handle redirects without one", async () => {
    const a = await register("Link_Owner");
    const res = await call("/referral/LINK_owner");
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location"));
    expect(loc.origin + loc.pathname).toBe("https://onchain-matrix.github.io/onmx-gamification/");
    expect(loc.hash).toBe("#signalsPanel");
    expect(loc.searchParams.get("ref")).toBe(a.json.refCode);
    const rt = loc.searchParams.get("rt");
    expect(rt).toMatch(/^v1\.[A-Z0-9]+\.\d+\.[0-9a-f]{32}$/);
    const exp = Number(rt.split(".")[2]);
    expect(exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(30 * 86400 - 60);
    const cookie = res.headers.get("Set-Cookie");
    expect(cookie).toBe(`onmx_ref=${rt}; Max-Age=2592000; Path=/; Secure; HttpOnly; SameSite=Lax`);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const unk = await call("/referral/nobody_here_x");
    expect(unk.status).toBe(302);
    expect(unk.headers.get("Set-Cookie")).toBeNull();
    const ul = new URL(unk.headers.get("Location"));
    expect(ul.searchParams.get("rt")).toBeNull();
    expect(ul.searchParams.get("ref")).toBeNull();
    const bad = await call("/referral/%E0%A4%A");
    expect(bad.status).toBe(302);
    expect(bad.headers.get("Set-Cookie")).toBeNull();

    // join with the token (as the page sends it) saves the referrer-recruit pair
    const j = await call("/v1/signals/register", { method: "POST", body: { handle: "link_recruit", refToken: rt }, headers: preview });
    expect(j.json.referral).toEqual({ status: "pending", referrer: "@link_owner", via: "link" });
    const pair = await env.DB.prepare(`SELECT referrer_id, status FROM referrals WHERE referred_id = ?`).bind(j.json.playerId).first();
    expect(pair).toEqual({ referrer_id: a.json.playerId, status: "pending" });

    // the Worker's own cookie also works when a browser sends it
    const c = await call("/v1/signals/register", { method: "POST", body: { handle: "link_cookie" }, headers: { ...preview, Cookie: `x=1; onmx_ref=${rt}` } });
    expect(c.json.referral.via).toBe("link");

    // expired (31 days later) → no referral, and no fallback to the plain code: no retroactive claims
    const late = await call("/v1/signals/register", { method: "POST", body: { handle: "link_late", refToken: rt, ref: a.json.refCode }, headers: preview, nowMs: Date.now() + 31 * 86400 * 1000 });
    expect(late.status).toBe(200);
    expect(late.json.referral).toEqual({ status: "ignored", reason: "ref_token_expired" });
    expect(await env.DB.prepare(`SELECT 1 FROM referrals WHERE referred_id = ?`).bind(late.json.playerId).first()).toBeNull();
    // tampered → ignored
    const forged = rt.replace(/\.[0-9a-f]{32}$/, "." + "0".repeat(32));
    const f = await call("/v1/signals/register", { method: "POST", body: { handle: "link_forged", refToken: forged }, headers: preview });
    expect(f.json.referral).toEqual({ status: "ignored", reason: "invalid_ref_token" });
    // self-referral through a link is still blocked
    const self = await call("/v1/signals/register", { method: "POST", body: { handle: "link_owner2", refToken: rt }, headers: { ...preview, "X-Player-Key": a.json.playerKey } });
    expect(self.json.error).toBe("self_referral");
    // a referred player can't be re-referred: re-registering the same handle is refused, referrer unchanged
    const again = await call("/v1/signals/register", { method: "POST", body: { handle: "link_recruit", refToken: rt }, headers: preview });
    expect(again.status).toBe(409);
  });

  it("admin delete removes a test player and all rows", async () => {
    const p = await register("tmp_del");
    await submit(p.json.playerKey, "tmp_del");
    const d = await call(`/v1/admin/players/${p.json.playerId}/delete`, { method: "POST", headers: admin, body: {} });
    expect(d.status).toBe(200);
    const left = await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM signal_players WHERE id = ?1) + (SELECT COUNT(*) FROM signals WHERE player_id = ?1) AS n`).bind(p.json.playerId).first();
    expect(left.n).toBe(0);
  });

  it("CSRF: mutations from a foreign origin are rejected", async () => {
    const r = await call("/v1/signals/register", { method: "POST", body: { handle: "evil1" }, headers: { ...preview, Origin: "https://evil.example" } });
    expect(r.status).toBe(403);
  });
});

describe("launch date guard", () => {
  afterEach(() => { clock.nowMs = START_MS; });

  it("approval before the start returns 409 season_not_started, leaves the signal pending, and writes no ledger rows", async () => {
    clock.nowMs = START_MS - 1;
    const r = await register("guard_before");
    const s = await submit(r.json.playerKey, "guard_before");
    expect(s.status).toBe(200);
    expect(s.json.status).toBe("pending");
    const ap = await approve(s.json.id);
    expect(ap.status).toBe(409);
    expect(ap.json.error).toBe("season_not_started");
    expect(ap.json.startsAt).toBe(POLICY.seasonStart);
    const row = await env.DB.prepare(`SELECT status, base_credits, bonus_credits, reviewed_at FROM signals WHERE id = ?`).bind(s.json.id).first();
    expect(row.status).toBe("pending");
    expect(row.base_credits).toBe(0);
    expect(row.reviewed_at).toBeNull();
    expect((await ledger(r.json.playerId)).length).toBe(0);
  });

  it("approval at the start instant succeeds and writes ledger rows; 1ms before still refused", async () => {
    const r = await register("guard_atstart");
    const s = await submit(r.json.playerKey, "guard_atstart");
    const early = await call(`/v1/admin/signals/${s.json.id}/approve`, { method: "POST", headers: admin, body: { tier: "accepted" }, nowMs: START_MS - 1 });
    expect(early.status).toBe(409);
    expect(early.json.error).toBe("season_not_started");
    const ap = await call(`/v1/admin/signals/${s.json.id}/approve`, { method: "POST", headers: admin, body: { tier: "accepted" }, nowMs: START_MS });
    expect(ap.status).toBe(200);
    expect(ap.json.status).toBe("approved");
    expect(ap.json.baseCredits).toBe(5);
    const l = await ledger(r.json.playerId);
    expect(l.map((x) => [x.kind, x.credits])).toEqual([["signal", 5]]);
  });

  it("referral shares before the start give nothing (approve path and grantReferralShares itself), including L2", async () => {
    clock.nowMs = START_MS; // set up players and a pending referral at/after start
    const top = await register("guard_l2top");
    const mid = await register("guard_l2mid", top.json.refCode);
    const m1 = await submit(mid.json.playerKey, "guard_l2mid");
    expect((await approve(m1.json.id)).json.referral.status).toBe("granted"); // top earns 5% of mid's points
    const newbie = await register("guard_l2new", mid.json.refCode);
    const n1 = await submit(newbie.json.playerKey, "guard_l2new");

    clock.nowMs = START_MS - 1;
    const ap = await approve(n1.json.id);
    expect(ap.status).toBe(409);
    expect(ap.json.error).toBe("season_not_started");
    const ref = await env.DB.prepare(`SELECT status, qualified_at, qualifying_signal_id FROM referrals WHERE referred_id = ?`).bind(newbie.json.playerId).first();
    expect(ref.status).toBe("pending");
    expect(ref.qualified_at).toBeNull();
    expect((await ledger(mid.json.playerId)).filter((x) => x.kind === "referral_l1").length).toBe(0);
    expect((await ledger(top.json.playerId)).filter((x) => x.kind === "referral_l2").length).toBe(0);

    // Direct call: still no writes if someone invoked qualification before the start
    const direct = await grantReferralShares(envAt(START_MS - 1), newbie.json.playerId, n1.json.id, 1, 5, new Date(START_MS - 1).toISOString());
    expect(direct).toEqual({ status: "season_not_started", grants: [] });
    const ref2 = await env.DB.prepare(`SELECT status FROM referrals WHERE referred_id = ?`).bind(newbie.json.playerId).first();
    expect(ref2.status).toBe("pending");
    expect((await ledger(mid.json.playerId)).filter((x) => x.kind === "referral_l1").length).toBe(0);
    expect((await ledger(top.json.playerId)).filter((x) => x.kind === "referral_l2").length).toBe(0);
  });

  it("outcome bonus grants are refused before the start and the existing bonus is left unchanged", async () => {
    clock.nowMs = START_MS;
    const r = await register("guard_bonus");
    const s = await submit(r.json.playerKey, "guard_bonus");
    const ap = await approve(s.json.id, "accepted", { kolReplied: true });
    expect(ap.status).toBe(200);
    expect(ap.json.bonusCredits).toBe(5);
    clock.nowMs = START_MS - 1;
    const out = await call(`/v1/admin/signals/${s.json.id}/outcomes`, { method: "POST", headers: admin, body: { outcomes: { kolReplied: true, introduction: true } } });
    expect(out.status).toBe(409);
    expect(out.json.error).toBe("season_not_started");
    const row = await env.DB.prepare(`SELECT bonus_credits FROM signals WHERE id = ?`).bind(s.json.id).first();
    expect(row.bonus_credits).toBe(5);
    const l = await ledger(r.json.playerId);
    expect(l.filter((x) => x.kind === "signal_bonus").map((x) => x.credits)).toEqual([5]);
  });

  it("submissions and rejects stay allowed before the start", async () => {
    clock.nowMs = START_MS - 1;
    const r = await register("guard_submit");
    const s = await submit(r.json.playerKey, "guard_submit");
    expect(s.status).toBe(200);
    expect(s.json.status).toBe("pending");
    const rj = await call(`/v1/admin/signals/${s.json.id}/reject`, { method: "POST", headers: admin, body: { reason: "off topic reply" } });
    expect(rj.status).toBe(200);
    expect(rj.json.status).toBe("rejected");
    expect((await ledger(r.json.playerId)).length).toBe(0);
  });

  it("after the season end, approval still grants points (no end-of-season block today)", async () => {
    clock.nowMs = END_MS;
    const r = await register("guard_afterend");
    const s = await submit(r.json.playerKey, "guard_afterend");
    const ap = await approve(s.json.id);
    expect(ap.status).toBe(200);
    expect(ap.json.status).toBe("approved");
    expect(ap.json.baseCredits).toBe(5);
    expect((await ledger(r.json.playerId)).map((x) => [x.kind, x.credits])).toEqual([["signal", 5]]);
  });
});
