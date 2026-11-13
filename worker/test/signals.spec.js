import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createWorker } from "../src/index.js";
import { applyMigrations } from "./apply-migrations.js";
import { validateSubmission, parseStatusUrl, signalBaseCredits, signalBonusCredits, SIGNAL_POLICY, REFERRAL_POLICY } from "../src/signals/policy.js";

const ORIGIN = "https://onchain-matrix.github.io";
const ADMIN = "test-admin-token-0123456789abcdef";
const worker = createWorker();
let seq = 0;
const sid = () => String(1900000000000000000n + BigInt(++seq) * 7919n);

async function call(path, { method = "GET", body, headers = {} } = {}) {
  const h = { Origin: ORIGIN, ...headers };
  if (body !== undefined) h["Content-Type"] = "application/json";
  const req = new Request("https://onmx-gamification-claims.onmx.workers.dev" + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
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
    expect(REFERRAL_POLICY.l1Credits).toBe(10);
    expect(REFERRAL_POLICY.l2Credits).toBe(5);
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

  it("referral qualifies only on the referred player's FIRST approved signal: L1 +10, L2 +5", async () => {
    const top = await register("ref_top");
    const mid = await register("ref_mid", top.json.refCode);
    expect(mid.json.referral.status).toBe("pending");
    expect(mid.json.referral.referrer).toBe("@ref_top");
    // mid becomes an approved contributor (qualifies top's L1)
    const m1 = await submit(mid.json.playerKey, "ref_mid");
    const new1 = await register("ref_new", mid.json.refCode);
    const n1 = await submit(new1.json.playerKey, "ref_new");
    const n2 = await submit(new1.json.playerKey, "ref_new");

    let meMid = await call("/v1/signals/me", { headers: { ...preview, "X-Player-Key": mid.json.playerKey } });
    expect(meMid.json.referrals.pending).toBe(1);
    expect(meMid.json.referrals.qualified).toBe(0);
    expect((await ledger(mid.json.playerId)).length).toBe(0); // no credit for a signup alone

    // rejection does not qualify
    await call(`/v1/admin/signals/${n1.json.id}/reject`, { method: "POST", headers: admin, body: { reason: "spam reply" } });
    expect((await ledger(mid.json.playerId)).length).toBe(0);

    expect((await approve(m1.json.id)).json.referral.status).toBe("qualified");
    const ap = await approve(n2.json.id);
    expect(ap.json.referral.status).toBe("qualified");
    expect(ap.json.referral.grants).toEqual([{ kind: "referral_l1", credits: 10 }, { kind: "referral_l2", credits: 5 }]);

    const lm = await ledger(mid.json.playerId);
    expect(lm.find((x) => x.kind === "referral_l1").credits).toBe(10);
    const lt = await ledger(top.json.playerId);
    expect(lt.filter((x) => x.kind === "referral_l1").length).toBe(1); // from mid
    expect(lt.find((x) => x.kind === "referral_l2").credits).toBe(5);  // from ref_new via mid
    meMid = await call("/v1/signals/me", { headers: { ...preview, "X-Player-Key": mid.json.playerKey } });
    expect(meMid.json.referrals.qualified).toBe(1);
    expect(meMid.json.referrals.pending).toBe(0);

    // a second approval for ref_new does not pay again
    const n3 = await submit(new1.json.playerKey, "ref_new");
    expect((await approve(n3.json.id)).json.referral.status).toBe("none");
    expect((await ledger(mid.json.playerId)).filter((x) => x.kind === "referral_l1").length).toBe(1);

    // revoke the qualifying signal → referral back to pending, referral credits removed
    const rv = await call(`/v1/admin/signals/${n2.json.id}/revoke`, { method: "POST", headers: admin, body: { reason: "found to be copy/paste" } });
    expect(rv.json.referralReset).toBe(true);
    expect((await ledger(mid.json.playerId)).filter((x) => x.kind === "referral_l1").length).toBe(0);
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

  it("qualified referrals capped per referrer per season (over_cap pays 0)", async () => {
    const r = await register("cap_ref");
    const rid = r.json.playerId;
    const now = new Date().toISOString();
    // seed 20 already-qualified referrals for this season directly
    const stmts = [];
    for (let i = 0; i < REFERRAL_POLICY.capQualifiedPerSeason; i++) {
      const id = "f".repeat(28) + String(1000 + i);
      stmts.push(env.DB.prepare(`INSERT INTO signal_players (id, handle, ref_code, token_hash, referrer_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(id, "capf" + i, "CAPF" + (1000 + i), "h" + i, rid, now));
      stmts.push(env.DB.prepare(`INSERT INTO referrals (referred_id, referrer_id, status, season, created_at) VALUES (?, ?, 'qualified', 1, ?)`).bind(id, rid, now));
    }
    await env.DB.batch(stmts);
    const n = await register("cap_new21", r.json.refCode);
    const s = await submit(n.json.playerKey, "cap_new21");
    const ap = await approve(s.json.id);
    expect(ap.json.referral.status).toBe("over_cap");
    expect((await ledger(rid)).length).toBe(0);
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
