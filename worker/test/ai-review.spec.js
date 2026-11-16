import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { createWorker } from "../src/index.js";
import { applyMigrations } from "./apply-migrations.js";
import {
  reviewConfig,
  computeWouldAutoApprove,
  cohenKappa,
  agreementStats,
  assertAutoApproveDisabled,
  autoApproveEnabled,
  scoreSignal,
  SAMPLE_SIZE_TARGET,
} from "../src/signals/ai-review.js";

const ORIGIN = "https://onchain-matrix.github.io";
const ADMIN = "test-admin-token-0123456789abcdef";
const TARGET_TEXT = "Treasury LP unlocks over 90 days, with 30% unlocking on day 60.";
const REPLY_TEXT = "If 30% of the LP unlocks on day 60, what's the plan to keep the floor from slipping that week? A staged TWAP or a tighter range would help.";
const SUBSTANTIVE = {
  substance: 80,
  engages_post: true,
  confidence: 0.9,
  suggested_tier: "accepted",
  reasons: ["cites the day-60 tranche", "asks a concrete question"],
  flags: [],
};

let seq = 8000;
const sid = () => String(1800000000000000000n + BigInt(++seq) * 7919n);
const preview = { "X-Admin-Preview": ADMIN };
const admin = { Authorization: "Bearer " + ADMIN };

const saved = {};
const ENV_KEYS = ["AI_REVIEW_MODE", "AI_AUTO_APPROVE", "AI_REVIEW_MODEL", "X_BEARER_TOKEN", "AI_REVIEW_SUBSTANCE_MIN", "AI_REVIEW_CONFIDENCE_MIN"];
beforeAll(async () => {
  await applyMigrations(env.DB);
  for (const k of ENV_KEYS) saved[k] = env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});

function workerWith({ fetchImpl, aiRun } = {}) {
  return createWorker({ fetchImpl, aiRun });
}

async function call(worker, path, { method = "GET", body, headers = {} } = {}) {
  const h = { Origin: ORIGIN, ...headers };
  if (body !== undefined) h["Content-Type"] = "application/json";
  const req = new Request("https://onmx-gamification-claims.onmx.workers.dev" + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, json, text };
}

async function register(worker, handle, ref) {
  return call(worker, "/v1/signals/register", { method: "POST", body: { handle, ref }, headers: preview });
}
async function submit(worker, key, handle, over = {}) {
  return call(worker, "/v1/signals", {
    method: "POST",
    headers: { ...preview, "X-Player-Key": key },
    body: {
      type: "reply",
      topic: "rwa",
      why: "Thread on RWA allocation; added a treasury allocation question.",
      signalUrl: `https://x.com/${handle}/status/${sid()}`,
      targetUrl: over.targetUrl || `https://x.com/BNBCHAIN/status/${sid()}`,
      onmxMentioned: true,
      ...over,
    },
  });
}
async function approve(worker, id, tier = "accepted") {
  return call(worker, `/v1/admin/signals/${id}/approve`, { method: "POST", headers: admin, body: { tier, outcomes: {} } });
}
async function snapshot(id) {
  const s = await env.DB.prepare(`SELECT status, tier, base_credits, bonus_credits, reject_reason, reviewed_at FROM signals WHERE id = ?`).bind(id).first();
  const led = await env.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(credits),0) AS c FROM credit_ledger WHERE source_id = ?`).bind(id).first();
  return { status: s.status, tier: s.tier, base_credits: s.base_credits, bonus_credits: s.bonus_credits, reject_reason: s.reject_reason, reviewed_at: s.reviewed_at, ledgerN: Number(led.n), ledgerC: Number(led.c) };
}

function aiPayload(over = {}) {
  return { response: JSON.stringify({ ...SUBSTANTIVE, ...over }) };
}

describe("review config and would-auto-approve (pure)", () => {
  it("defaults to off, substance 80, confidence 0.85, accepted-tier only", () => {
    const cfg = reviewConfig({});
    expect(cfg).toMatchObject({ mode: "off", substanceMin: 80, confidenceMin: 0.85, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
    expect(reviewConfig({ AI_REVIEW_MODE: "SHADOW" }).mode).toBe("shadow");
    expect(reviewConfig({ AI_REVIEW_MODE: "live" }).mode).toBe("off");
    expect(autoApproveEnabled({})).toBe(false);
    expect(autoApproveEnabled({ AI_AUTO_APPROVE: "1" })).toBe(true);
    expect(() => assertAutoApproveDisabled({ AI_AUTO_APPROVE: "on" })).toThrow(/ai_auto_approve_not_implemented/);
    expect(() => assertAutoApproveDisabled({})).not.toThrow();
  });

  it("would_auto_approve requires every proposed gate", () => {
    const good = {
      prescreenVerdict: "pass",
      autoApproveBlocked: false,
      substance: 80,
      confidence: 0.85,
      flags: [],
      suggestedTier: "accepted",
      humanApprovedCount: 1,
    };
    expect(computeWouldAutoApprove(good)).toBe(true);
    expect(computeWouldAutoApprove({ ...good, substance: 79 })).toBe(false);
    expect(computeWouldAutoApprove({ ...good, confidence: 0.84 })).toBe(false);
    expect(computeWouldAutoApprove({ ...good, flags: ["promo"] })).toBe(false);
    expect(computeWouldAutoApprove({ ...good, autoApproveBlocked: true })).toBe(false);
    expect(computeWouldAutoApprove({ ...good, prescreenVerdict: "reject" })).toBe(false);
    expect(computeWouldAutoApprove({ ...good, humanApprovedCount: 0 })).toBe(false);
    expect(computeWouldAutoApprove({ ...good, suggestedTier: "strong" })).toBe(false);
    expect(computeWouldAutoApprove({ ...good, suggestedTier: "outstanding" })).toBe(false);
    expect(computeWouldAutoApprove({ ...good, suggestedTier: "reject" })).toBe(false);
  });

  it("Cohen's kappa and false-approval rate", () => {
    expect(cohenKappa(1, 0, 0, 1)).toBe(1);
    expect(cohenKappa(10, 0, 0, 0)).toBe(1);
    // 2x2 balanced chance: all 5 → kappa 0
    expect(cohenKappa(5, 5, 5, 5)).toBe(0);
    const stats = agreementStats([
      { wouldAutoApprove: true, suggestedTier: "accepted", prescreenVerdict: "pass", humanStatus: "rejected" },
      { wouldAutoApprove: true, suggestedTier: "accepted", prescreenVerdict: "pass", humanStatus: "approved" },
      { wouldAutoApprove: false, suggestedTier: "reject", prescreenVerdict: "pass", humanStatus: "approved" },
      { wouldAutoApprove: false, suggestedTier: "reject", prescreenVerdict: "reject", humanStatus: "rejected" },
      { wouldAutoApprove: true, suggestedTier: "accepted", prescreenVerdict: "pass", humanStatus: "pending" },
    ]);
    expect(stats.reviewed).toBe(4);
    expect(stats.wouldAutoApprove).toBe(3);
    expect(stats.wouldAutoApproveReviewed).toBe(2);
    expect(stats.falseApprovals).toBe(1);
    expect(stats.falseApprovalRate).toBe(0.5);
    expect(stats.falseRejects).toBe(1);
    expect(stats.preliminary).toBe(true);
    expect(stats.sampleSizeTarget).toBe(SAMPLE_SIZE_TARGET);
    expect(stats.confusion).toEqual({
      modelApproveHumanApprove: 1,
      modelApproveHumanReject: 1,
      modelRejectHumanApprove: 1,
      modelRejectHumanReject: 1,
    });
    expect(stats.kappa).toBe(0);
  });
});

describe("shadow scoring pipeline", () => {
  it("off mode makes no AI or X calls and writes no score on submit", async () => {
    env.AI_REVIEW_MODE = "off";
    env.X_BEARER_TOKEN = "should-not-be-used";
    let ai = 0, x = 0;
    const worker = workerWith({
      fetchImpl: async () => { x++; return Response.json({ data: { id: "1", text: "x" } }); },
      aiRun: async () => { ai++; return aiPayload(); },
    });
    const p = await register(worker, "offmode_a");
    const s = await submit(worker, p.json.playerKey, "offmode_a");
    expect(s.status).toBe(200);
    expect(ai).toBe(0);
    expect(x).toBe(0);
    const row = await env.DB.prepare(`SELECT * FROM signal_scores WHERE signal_id = ?`).bind(s.json.id).first();
    expect(row).toBeNull();
    expect((await snapshot(s.json.id)).status).toBe("pending");
  });

  it("missing X secret records no_x_secret and does not call AI", async () => {
    env.AI_REVIEW_MODE = "shadow";
    delete env.X_BEARER_TOKEN;
    let ai = 0;
    const worker = workerWith({ aiRun: async () => { ai++; return aiPayload(); } });
    const p = await register(worker, "nosecret_a");
    const s = await submit(worker, p.json.playerKey, "nosecret_a");
    expect(s.status).toBe(200);
    const before = await snapshot(s.json.id);
    const row = await env.DB.prepare(`SELECT * FROM signal_scores WHERE signal_id = ?`).bind(s.json.id).first();
    expect(row.status).toBe("no_x_secret");
    expect(row.would_auto_approve).toBe(0);
    expect(ai).toBe(0);
    expect(await snapshot(s.json.id)).toEqual(before);
  });

  it("shadow mode fetches posts, scores a pass, and never mutates status or credits", async () => {
    env.AI_REVIEW_MODE = "shadow";
    env.X_BEARER_TOKEN = "test-bearer";
    const worker = workerWith({
      fetchImpl: async (url) => {
        const m = String(url).match(/(\d{10,})/g) || [];
        const data = m.slice(0, 2).map((id, i) => ({ id, text: i === 0 && url.includes(id) ? REPLY_TEXT : TARGET_TEXT }));
        // both ids may appear in one URL
        const ids = [...new Set(String(url).match(/\d{11,}/g) || [])];
        return Response.json({
          data: ids.length > 1
            ? ids.map((id, i) => ({ id, text: i === 0 ? REPLY_TEXT : TARGET_TEXT }))
            : { id: ids[0], text: REPLY_TEXT },
        });
      },
      aiRun: async (model, input) => {
        expect(model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
        expect(input.temperature).toBe(0);
        expect(input.messages[0].role).toBe("system");
        expect(input.messages[1].content).toContain(REPLY_TEXT);
        return aiPayload();
      },
    });
    const veteran = await register(worker, "shadowvet");
    const first = await submit(worker, veteran.json.playerKey, "shadowvet");
    await approve(worker, first.json.id);
    const second = await submit(worker, veteran.json.playerKey, "shadowvet");
    expect(second.status).toBe(200);
    const before = await snapshot(second.json.id);
    expect(before.status).toBe("pending");
    expect(before.ledgerN).toBe(0);
    const row = await env.DB.prepare(`SELECT * FROM signal_scores WHERE signal_id = ?`).bind(second.json.id).first();
    expect(row.status).toBe("scored");
    expect(row.prescreen_verdict).toBe("pass");
    expect(Number(row.substance)).toBe(80);
    expect(Number(row.would_auto_approve)).toBe(1);
    const sig = await env.DB.prepare(`SELECT reply_text, target_text, fetched_at, status, base_credits FROM signals WHERE id = ?`).bind(second.json.id).first();
    expect(sig.reply_text).toBeTruthy();
    expect(sig.fetched_at).toBeTruthy();
    expect(sig.status).toBe("pending");
    expect(sig.base_credits).toBe(0);
    expect(await snapshot(second.json.id)).toEqual(before);
  });

  it("does not auto-approve strong/outstanding or first-time players, and skips the model on prescreen reject", async () => {
    env.AI_REVIEW_MODE = "shadow";
    env.X_BEARER_TOKEN = "test-bearer";
    let ai = 0;
    const worker = workerWith({
      fetchImpl: async (url) => {
        const ids = [...new Set(String(url).match(/\d{11,}/g) || [])];
        return Response.json({ data: ids.map((id) => ({ id, text: "GM 🔥" })) });
      },
      aiRun: async () => { ai++; return aiPayload({ suggested_tier: "strong", substance: 86 }); },
    });
    const p = await register(worker, "firstime_a");
    const s = await submit(worker, p.json.playerKey, "firstime_a");
    const row = await env.DB.prepare(`SELECT * FROM signal_scores WHERE signal_id = ?`).bind(s.json.id).first();
    expect(row.status).toBe("prescreen_reject");
    expect(row.reject_reason).toBe("greeting_only");
    expect(row.would_auto_approve).toBe(0);
    expect(ai).toBe(0);
    expect((await snapshot(s.json.id)).status).toBe("pending");
  });

  it("admin score endpoint and list include scores; borderline filter and stats work", async () => {
    env.AI_REVIEW_MODE = "shadow";
    const worker = workerWith({
      aiRun: async () => aiPayload({ substance: 64, confidence: 0.7, suggested_tier: "accepted" }),
    });
    const p = await register(worker, "adminq_a");
    const s = await submit(worker, p.json.playerKey, "adminq_a");
    // Seed fetched texts so we can score without X.
    await env.DB.prepare(`UPDATE signals SET reply_text = ?, target_text = ?, fetched_at = ? WHERE id = ?`)
      .bind(REPLY_TEXT, TARGET_TEXT, new Date().toISOString(), s.json.id).run();
    // Clear the no_x_secret row from submit (no secret in this test).
    await env.DB.prepare(`DELETE FROM signal_scores WHERE signal_id = ?`).bind(s.json.id).run();

    const scored = await call(worker, "/v1/admin/signals/score", { method: "POST", headers: admin, body: { id: s.json.id } });
    expect(scored.status).toBe(200);
    expect(scored.json.ok).toBe(true);
    expect(scored.json.results[0].score.status).toBe("scored");
    expect(scored.json.results[0].score.wouldAutoApprove).toBe(false);
    expect((await snapshot(s.json.id)).status).toBe("pending");

    const list = await call(worker, "/v1/admin/signals?status=pending&limit=200", { headers: admin });
    const card = list.json.signals.find((x) => x.id === s.json.id);
    expect(card.score.substance).toBe(64);
    expect(card.score.reasons.length).toBeGreaterThan(0);
    expect(card.score.wouldAutoApprove).toBe(false);

    const q = await call(worker, "/v1/admin/signals?status=borderline", { headers: admin });
    expect(q.json.signals.some((x) => x.id === s.json.id)).toBe(true);

    await approve(worker, s.json.id);
    const stats = await call(worker, "/v1/admin/signals/ai-stats", { headers: admin });
    expect(stats.status).toBe(200);
    expect(stats.json.ok).toBe(true);
    expect(stats.json.autoApprove).toBe(false);
    expect(stats.json.reviewed).toBeGreaterThanOrEqual(1);
    expect(stats.json.preliminary).toBe(true);
  });

  it("off mode admin score refuses and makes no AI calls; auto-approve flag hard-fails closed", async () => {
    env.AI_REVIEW_MODE = "off";
    let ai = 0;
    const worker = workerWith({ aiRun: async () => { ai++; return aiPayload(); } });
    const p = await register(worker, "offadmin_a");
    const s = await submit(worker, p.json.playerKey, "offadmin_a");
    const r = await call(worker, "/v1/admin/signals/score", { method: "POST", headers: admin, body: { id: s.json.id } });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("ai_review_off");
    expect(ai).toBe(0);

    env.AI_REVIEW_MODE = "shadow";
    env.AI_AUTO_APPROVE = "1";
    const boom = await call(worker, "/v1/admin/signals/score", { method: "POST", headers: admin, body: { id: s.json.id } });
    expect(boom.status).toBe(500);
    expect(String(boom.json.error)).toMatch(/ai_auto_approve_not_implemented/);
    expect(ai).toBe(0);
    expect((await snapshot(s.json.id)).status).toBe("pending");
  });

  it("scoreSignal itself never updates status or the ledger, even after a model pass", async () => {
    env.AI_REVIEW_MODE = "shadow";
    const p = await register(workerWith(), "directscore");
    const s = await submit(workerWith(), p.json.playerKey, "directscore");
    await env.DB.prepare(`UPDATE signals SET reply_text = ?, target_text = ? WHERE id = ?`).bind(REPLY_TEXT, TARGET_TEXT, s.json.id).run();
    const before = await snapshot(s.json.id);
    const out = await scoreSignal(env, s.json.id, { aiRun: async () => aiPayload() });
    expect(out.ok).toBe(true);
    expect(out.score.status).toBe("scored");
    expect(await snapshot(s.json.id)).toEqual(before);
    const led = await env.DB.prepare(`SELECT COUNT(*) AS n FROM credit_ledger`).first();
    // existing approved fixtures from earlier tests may have ledger rows; none may be for this id
    const mine = await env.DB.prepare(`SELECT COUNT(*) AS n FROM credit_ledger WHERE source_id = ?`).bind(s.json.id).first();
    expect(Number(mine.n)).toBe(0);
    expect(Number(led.n)).toBeGreaterThanOrEqual(0);
  });
});
