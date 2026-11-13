import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createWorker } from "../src/index.js";
import { rankRows } from "../src/signals/handlers.js";
import { applyMigrations } from "./apply-migrations.js";

const ORIGIN = "https://onchain-matrix.github.io";
const ADMIN = "test-admin-token-0123456789abcdef";
const worker = createWorker();
let n = 0;
async function call(path, headers = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request("https://onmx-gamification-claims.onmx.workers.dev" + path, { headers: { Origin: ORIGIN, ...headers } }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json(), headers: res.headers };
}
async function player(handle, { preview = 0 } = {}) {
  const id = (++n).toString(16).padStart(32, "a");
  await env.DB.prepare(`INSERT INTO signal_players (id, handle, ref_code, token_hash, preview, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, handle, "LB" + String(100000 + n), "th" + n, preview, "2026-11-18T17:00:00Z").run();
  return id;
}
async function credit(pid, kind, credits, at, season = 1) {
  await env.DB.prepare(`INSERT INTO credit_ledger (id, player_id, season, kind, credits, label, source_id, created_at) VALUES (?, ?, ?, ?, ?, 'test', ?, ?)`)
    .bind("l" + (++n), pid, season, kind, credits, "src" + n, at).run();
}

beforeAll(async () => { await applyMigrations(env.DB); });

describe("leaderboard ranking (pure)", () => {
  it("orders by credits desc, ties by earlier reachedAt then handle; drops zero", () => {
    const r = rankRows([
      { handle: "b", credits: 10, reached_at: "2026-11-19T10:00:00Z" },
      { handle: "a", credits: 10, reached_at: "2026-11-19T10:00:00Z" },
      { handle: "c", credits: 10, reached_at: "2026-11-19T09:00:00Z" },
      { handle: "d", credits: 25, reached_at: "2026-11-20T00:00:00Z" },
      { handle: "z", credits: 0, reached_at: "2026-11-18T00:00:00Z" },
    ]);
    expect(r.map((x) => [x.rank, x.handle])).toEqual([[1, "d"], [2, "c"], [3, "a"], [4, "b"]]);
  });
});

describe("GET /v1/leaderboard", () => {
  it("ranks approved signal Credits for the season; excludes referral Credits, other seasons and preview rows; ties by time", async () => {
    const top = await player("lb_top");
    const early = await player("lb_early");
    const late = await player("lb_late");
    const refOnly = await player("lb_refonly");
    const pv = await player("lb_preview", { preview: 1 });
    await credit(top, "signal", 20, "2026-11-19T10:00:00Z");
    await credit(top, "signal_bonus", 5, "2026-11-19T10:00:00Z");
    await credit(top, "referral_l1", 10, "2026-11-19T11:00:00Z");      // must not change season rank
    await credit(early, "signal", 10, "2026-11-19T08:00:00Z");
    await credit(late, "signal", 5, "2026-11-19T07:00:00Z");
    await credit(late, "signal", 5, "2026-11-19T09:00:00Z");           // reaches 10 later than lb_early
    await credit(late, "signal", 50, "2026-12-20T09:00:00Z", 2);       // season 2 — excluded from season 1
    await credit(refOnly, "referral_l1", 10, "2026-11-19T06:00:00Z");
    await credit(refOnly, "referral_l2", 5, "2026-11-19T06:00:00Z");
    await credit(pv, "signal", 99, "2026-11-19T06:00:00Z");

    const r = await call("/v1/leaderboard?season=1");
    expect(r.status).toBe(200);
    expect(r.json.ranking).toBe("approved_signal_credits");
    expect(r.json.top).toEqual([
      { rank: 1, handle: "@lb_top", seasonCredits: 25 },
      { rank: 2, handle: "@lb_early", seasonCredits: 10 },
      { rank: 3, handle: "@lb_late", seasonCredits: 10 },
    ]);
    expect(r.json.totalRanked).toBe(3);
    expect(r.headers.get("cache-control")).toContain("public");
    // public-safe fields only
    expect(Object.keys(r.json.top[0]).sort()).toEqual(["handle", "rank", "seasonCredits"]);
    expect(JSON.stringify(r.json)).not.toMatch(/player_id|playerId|ip_hash|token|ref_code/);

    const look = await call("/v1/leaderboard?season=1&handle=@LB_TOP");
    expect(look.json.player).toEqual({ handle: "@lb_top", rank: 1, seasonCredits: 25, lifetimeCredits: 35 });
    const ref = await call("/v1/leaderboard?handle=lb_refonly");
    expect(ref.json.player).toEqual({ handle: "@lb_refonly", rank: null, seasonCredits: 0, lifetimeCredits: 15 });
    const lateLook = await call("/v1/leaderboard?handle=lb_late");
    expect(lateLook.json.player.lifetimeCredits).toBe(60);
    expect((await call("/v1/leaderboard?handle=lb_preview")).json.player).toBeNull();
    expect((await call("/v1/leaderboard?handle=nobody_here")).json.player).toBeNull();

    const s2 = await call("/v1/leaderboard?season=2");
    expect(s2.json.top).toEqual([{ rank: 1, handle: "@lb_late", seasonCredits: 50 }]);

    const prev = await call("/v1/leaderboard?season=1", { "X-Admin-Preview": ADMIN });
    expect(prev.json.preview).toBe(true);
    expect(prev.json.top[0]).toEqual({ rank: 1, handle: "@lb_preview", seasonCredits: 99 });
    expect(prev.headers.get("cache-control")).toBe("no-store");
    const bad = await call("/v1/leaderboard?season=1", { "X-Admin-Preview": "wrong" });
    expect(bad.json.preview).toBe(false);
    expect(bad.json.top.some((x) => x.handle === "@lb_preview")).toBe(false);
  });

  it("limit caps the top list (max 100) and empty board is valid", async () => {
    const r = await call("/v1/leaderboard?season=7&limit=5000");
    expect(r.status).toBe(200);
    expect(r.json.top).toEqual([]);
    expect(r.json.totalRanked).toBe(0);
  });
});
