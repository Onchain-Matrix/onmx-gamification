/**
 * Matrix Signals submission/review + server-side referral (PROPOSED rules; UI flags OFF until owner approves).
 * - Players register a claimed X handle and receive a player key (shown once; only its hash is stored).
 * - Credits are written ONLY by reviewer approval (admin token). Players can never self-award.
 * - While SIGNALS_OPEN !== "1", player endpoints require a valid admin preview header (owner preview / smoke tests).
 */
import { SIGNAL_POLICY, REFERRAL_POLICY, referralL1Points, referralL2Points, canonHandle, validateSubmission, cleanOutcomes, signalBaseCredits, signalBonusCredits } from "./policy.js";
import { randomId, randomBytes, sha256Hex, timingSafeEqual } from "../lib/crypto.js";
import { rateLimit } from "../lib/rate.js";

const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function signalsPublicConfig(env) {
  return {
    open: env.SIGNALS_OPEN === "1",
    policyVersion: SIGNAL_POLICY.version,
    referralVersion: REFERRAL_POLICY.version,
    adminConfigured: !!env.ADMIN_TOKEN,
  };
}

function season(env) {
  const n = Number(env.SEASON_NUMBER || 1);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function newRefCode() {
  const b = randomBytes(8);
  return [...b].map((x) => REF_ALPHABET[x % REF_ALPHABET.length]).join("");
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "local";
}

async function ipHash(env, request) {
  return (await sha256Hex((env.SESSION_SECRET || "nosalt") + "|ip|" + clientIp(request))).slice(0, 24);
}

function bearer(request) {
  const h = request.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

async function tokenMatches(env, presented) {
  if (!env.ADMIN_TOKEN || !presented) return false;
  const a = await sha256Hex(presented);
  const b = await sha256Hex(env.ADMIN_TOKEN);
  return timingSafeEqual(a, b);
}

/** Admin auth: Authorization: Bearer <ADMIN_TOKEN>. Failed attempts are rate limited per IP. */
export async function requireAdmin(env, request) {
  if (!env.ADMIN_TOKEN) return { ok: false, status: 503, error: "admin_not_configured" };
  const presented = bearer(request);
  if (await tokenMatches(env, presented)) return { ok: true };
  const rl = await rateLimit(env.DB, `adminfail:${clientIp(request)}`, 20, 600_000);
  if (!rl.ok) return { ok: false, status: 429, error: "rate_limited" };
  return { ok: false, status: 401, error: "admin_unauthorized" };
}

/** Player endpoints are open only when SIGNALS_OPEN=1, or with a valid X-Admin-Preview header (owner preview). */
async function gateOpen(env, request) {
  if (env.SIGNALS_OPEN === "1") return { ok: true, preview: false };
  const hdr = request.headers.get("X-Admin-Preview") || "";
  if (hdr && (await tokenMatches(env, hdr))) return { ok: true, preview: true };
  return { ok: false, status: 503, error: "signals_not_open" };
}

async function loadPlayerByKey(env, request) {
  const key = request.headers.get("X-Player-Key") || "";
  if (!key || key.length < 20 || key.length > 200) return null;
  const h = await sha256Hex(key);
  return env.DB.prepare(`SELECT * FROM signal_players WHERE token_hash = ?`).bind(h).first();
}

function publicSignal(r) {
  return {
    id: r.id,
    type: r.signal_type,
    topic: r.topic,
    signalUrl: r.signal_url,
    targetUrl: r.target_url,
    status: r.status,
    tier: r.tier,
    credits: (Number(r.base_credits) || 0) + (Number(r.bonus_credits) || 0),
    rejectReason: r.reject_reason,
    submittedAt: r.submitted_at,
    reviewedAt: r.reviewed_at,
  };
}

async function referralStats(env, playerId) {
  const rows = await env.DB.prepare(`SELECT status, COUNT(*) AS n FROM referrals WHERE referrer_id = ? GROUP BY status`).bind(playerId).all();
  const by = Object.fromEntries((rows.results || []).map((r) => [r.status, Number(r.n)]));
  const credits = await env.DB.prepare(
    `SELECT kind, COALESCE(SUM(credits),0) AS c FROM credit_ledger WHERE player_id = ? AND kind LIKE 'referral_%' GROUP BY kind`
  ).bind(playerId).all();
  const ck = Object.fromEntries((credits.results || []).map((r) => [r.kind, Number(r.c)]));
  return {
    pending: by.pending || 0,
    qualified: by.qualified || 0,
    overCap: by.over_cap || 0,
    l1Credits: ck.referral_l1 || 0,
    l2Credits: ck.referral_l2 || 0,
    welcomeCredits: ck.referral_welcome || 0,
    cap: REFERRAL_POLICY.capQualifiedPerSeason,
  };
}

// ---------------- player endpoints ----------------

export async function handleRegister(env, request, body) {
  const gate = await gateOpen(env, request);
  if (!gate.ok) return [gate.status, { ok: false, error: gate.error }];
  const rl = await rateLimit(env.DB, `sigreg:${clientIp(request)}`, 10, 3_600_000);
  if (!rl.ok) return [429, { ok: false, error: "rate_limited" }];

  const handle = canonHandle(body.handle);
  if (!handle) return [400, { ok: false, error: "invalid_handle" }];
  const exists = await env.DB.prepare(`SELECT id FROM signal_players WHERE handle = ?`).bind(handle).first();
  if (exists) return [409, { ok: false, error: "handle_taken", note: "This handle is already registered. Contact the team if it is yours." }];

  let referrer = null;
  let referral = { status: "none" };
  const code = String(body.ref || "").trim().toUpperCase();
  if (code) {
    referrer = await env.DB.prepare(`SELECT id, handle, token_hash FROM signal_players WHERE ref_code = ?`).bind(code).first();
    if (!referrer) {
      referral = { status: "ignored", reason: "unknown_code" };
    } else {
      // Self-referral: same handle, or this browser already holds the referrer's player key.
      const heldKey = request.headers.get("X-Player-Key") || "";
      const held = heldKey ? await sha256Hex(heldKey) : "";
      if (referrer.handle === handle || (held && held === referrer.token_hash)) {
        return [400, { ok: false, error: "self_referral" }];
      }
      referral = { status: "pending", referrer: "@" + referrer.handle };
    }
  }

  const id = randomId(16);
  const playerKey = "onmxp_" + randomId(24);
  const now = new Date().toISOString();
  const ip = await ipHash(env, request);
  let refCode = newRefCode();
  for (let i = 0; i < 4; i++) {
    const clash = await env.DB.prepare(`SELECT 1 FROM signal_players WHERE ref_code = ?`).bind(refCode).first();
    if (!clash) break;
    refCode = newRefCode();
  }
  const stmts = [
    env.DB.prepare(
      `INSERT INTO signal_players (id, handle, ref_code, token_hash, referrer_id, referred_at, ip_hash, preview, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, handle, refCode, await sha256Hex(playerKey), referrer ? referrer.id : null, referrer ? now : null, ip, gate.preview ? 1 : 0, now),
  ];
  if (referrer) {
    stmts.push(
      env.DB.prepare(`INSERT INTO referrals (referred_id, referrer_id, status, created_at) VALUES (?, ?, 'pending', ?)`).bind(id, referrer.id, now)
    );
  }
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) return [409, { ok: false, error: "handle_taken" }];
    throw e;
  }
  return [200, {
    ok: true,
    playerId: id,
    handle: "@" + handle,
    playerKey,
    refCode,
    referral,
    preview: gate.preview,
    note: "Keep your player key private. It is shown once and only works in browsers where you save it.",
  }];
}

export async function handleMe(env, request) {
  const gate = await gateOpen(env, request);
  if (!gate.ok) return [gate.status, { ok: false, error: gate.error }];
  const p = await loadPlayerByKey(env, request);
  if (!p) return [401, { ok: false, error: "player_unauthorized" }];
  const sig = await env.DB.prepare(`SELECT * FROM signals WHERE player_id = ? ORDER BY submitted_at DESC LIMIT 50`).bind(p.id).all();
  const s = season(env);
  const cred = await env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN kind IN ('signal','signal_bonus') AND season = ? THEN credits END),0) AS seasonSignal,
            COALESCE(SUM(CASE WHEN kind IN ('signal','signal_bonus') THEN credits END),0) AS lifetimeSignal,
            COALESCE(SUM(CASE WHEN kind LIKE 'referral_%' THEN credits END),0) AS referral
     FROM credit_ledger WHERE player_id = ?`
  ).bind(s, p.id).first();
  const referrer = p.referrer_id ? await env.DB.prepare(`SELECT handle FROM signal_players WHERE id = ?`).bind(p.referrer_id).first() : null;
  const myRef = await env.DB.prepare(`SELECT status FROM referrals WHERE referred_id = ?`).bind(p.id).first();
  return [200, {
    ok: true,
    handle: "@" + p.handle,
    refCode: p.ref_code,
    referredBy: referrer ? { handle: "@" + referrer.handle, status: myRef ? myRef.status : "pending" } : null,
    season: s,
    credits: {
      seasonSignal: Number(cred.seasonSignal) || 0,
      lifetimeSignal: Number(cred.lifetimeSignal) || 0,
      referralLifetime: Number(cred.referral) || 0,
    },
    referrals: await referralStats(env, p.id),
    signals: (sig.results || []).map(publicSignal),
    limits: { perDay: SIGNAL_POLICY.maxSubmissionsPerDay, pendingMax: SIGNAL_POLICY.maxPendingTotal },
  }];
}

export async function handleSubmit(env, request, body) {
  const gate = await gateOpen(env, request);
  if (!gate.ok) return [gate.status, { ok: false, error: gate.error }];
  const p = await loadPlayerByKey(env, request);
  if (!p) return [401, { ok: false, error: "player_unauthorized" }];
  const v = validateSubmission(body, p.handle);
  if (!v.ok) return [400, { ok: false, error: v.error }];
  const day = new Date().toISOString().slice(0, 10);
  const counts = await env.DB.prepare(
    `SELECT SUM(CASE WHEN submitted_day = ? THEN 1 ELSE 0 END) AS today, SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
     FROM signals WHERE player_id = ?`
  ).bind(day, p.id).first();
  if ((Number(counts?.today) || 0) >= SIGNAL_POLICY.maxSubmissionsPerDay) return [429, { ok: false, error: "daily_limit", limit: SIGNAL_POLICY.maxSubmissionsPerDay }];
  if ((Number(counts?.pending) || 0) >= SIGNAL_POLICY.maxPendingTotal) return [429, { ok: false, error: "pending_limit", limit: SIGNAL_POLICY.maxPendingTotal }];
  if (v.value.signalKey) {
    const dup = await env.DB.prepare(`SELECT 1 FROM signals WHERE signal_key = ?`).bind(v.value.signalKey).first();
    if (dup) return [409, { ok: false, error: "duplicate_signal" }];
  }
  if (v.value.targetKey) {
    const dupT = await env.DB.prepare(`SELECT 1 FROM signals WHERE player_id = ? AND target_key = ?`).bind(p.id, v.value.targetKey).first();
    if (dupT) return [409, { ok: false, error: "duplicate_target", note: "One signal per target post per player." }];
  }
  const id = randomId(16);
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO signals (id, player_id, season, signal_type, signal_url, signal_key, target_url, target_key, target_handle, topic, onmx_mentioned, why, status, submitted_at, submitted_day, preview)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    ).bind(
      id, p.id, season(env), v.value.type, v.value.signalUrl, v.value.signalKey, v.value.targetUrl, v.value.targetKey, v.value.targetHandle,
      v.value.topic, v.value.onmxMentioned ? 1 : 0, v.value.why, now, day, gate.preview || p.preview ? 1 : 0
    ).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) return [409, { ok: false, error: "duplicate_signal" }];
    throw e;
  }
  return [200, { ok: true, id, status: "pending", note: "Submitted for review. Credits are added only if a reviewer approves it." }];
}

export async function handleResolveRef(env, url) {
  const code = String(url.searchParams.get("code") || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{4,16}$/.test(code)) return [200, { ok: true, valid: false }];
  const r = await env.DB.prepare(`SELECT handle FROM signal_players WHERE ref_code = ?`).bind(code).first();
  return [200, r ? { ok: true, valid: true, referrer: "@" + r.handle } : { ok: true, valid: false }];
}

// ---------------- admin endpoints ----------------

const ADMIN_SELECT = `SELECT s.*, p.handle AS player_handle, p.ip_hash AS player_ip, p.referrer_id AS player_referrer,
  rp.handle AS referrer_handle, rp.ip_hash AS referrer_ip,
  (SELECT COUNT(*) FROM signals s2 WHERE s2.target_key = s.target_key AND s2.id <> s.id AND s.target_key IS NOT NULL) AS same_target_count,
  (SELECT COUNT(*) FROM signals s3 WHERE s3.player_id = s.player_id AND s3.status = 'approved') AS player_approved_count
  FROM signals s JOIN signal_players p ON p.id = s.player_id LEFT JOIN signal_players rp ON rp.id = p.referrer_id`;

function adminRow(r) {
  let outcomes = null;
  try { outcomes = r.outcomes_json ? JSON.parse(r.outcomes_json) : null; } catch { outcomes = null; }
  return {
    ...publicSignal(r),
    handle: "@" + r.player_handle,
    playerId: r.player_id,
    season: r.season,
    targetHandle: r.target_handle ? "@" + r.target_handle : null,
    why: r.why,
    onmxMentioned: !!r.onmx_mentioned,
    outcomes,
    baseCredits: Number(r.base_credits) || 0,
    bonusCredits: Number(r.bonus_credits) || 0,
    reviewerNote: r.reviewer_note,
    preview: !!r.preview,
    referrer: r.referrer_handle ? "@" + r.referrer_handle : null,
    flags: {
      sameIpAsReferrer: !!(r.referrer_ip && r.player_ip && r.referrer_ip === r.player_ip),
      otherSignalsOnTarget: Number(r.same_target_count) || 0,
      firstApproval: (Number(r.player_approved_count) || 0) === 0,
    },
  };
}

export async function adminList(env, url) {
  const status = String(url.searchParams.get("status") || "pending");
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
  const where = ["pending", "approved", "rejected"].includes(status) ? `WHERE s.status = ?` : "";
  const stmt = env.DB.prepare(`${ADMIN_SELECT} ${where} ORDER BY s.submitted_at ${status === "pending" ? "ASC" : "DESC"} LIMIT ${limit}`);
  const rows = where ? await stmt.bind(status).all() : await stmt.all();
  return [200, { ok: true, status, signals: (rows.results || []).map(adminRow) }];
}

async function qualifyReferral(env, referredId, signalId, s, now) {
  const ref = await env.DB.prepare(`SELECT * FROM referrals WHERE referred_id = ?`).bind(referredId).first();
  if (!ref || ref.status !== "pending") return { status: ref ? ref.status : "none" };
  const P = REFERRAL_POLICY;
  const q = await env.DB.prepare(`SELECT COUNT(*) AS n FROM referrals WHERE referrer_id = ? AND status = 'qualified' AND season = ?`).bind(ref.referrer_id, s).first();
  const nth = (Number(q?.n) || 0) + 1; // 1-based, including this referral
  const overCap = nth > P.capQualifiedPerSeason;
  const l1 = overCap ? 0 : referralL1Points(nth, P);
  const l2 = referralL2Points(l1);
  const upd = await env.DB.prepare(
    `UPDATE referrals SET status = ?, season = ?, qualified_at = ?, qualifying_signal_id = ? WHERE referred_id = ? AND status = 'pending'`
  ).bind(overCap ? "over_cap" : "qualified", s, now, signalId, referredId).run();
  if (!upd.meta?.changes) return { status: "race" };
  const referred = await env.DB.prepare(`SELECT handle FROM signal_players WHERE id = ?`).bind(referredId).first();
  const grants = [];
  const stmts = [];
  if (!overCap && l1 > 0) {
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO credit_ledger (id, player_id, season, kind, credits, label, source_id, created_at) VALUES (?, ?, ?, 'referral_l1', ?, ?, ?, ?)`
    ).bind(randomId(16), ref.referrer_id, s, l1, `Referral (level 1): @${referred.handle} first approved signal`, referredId, now));
    grants.push({ kind: "referral_l1", credits: l1 });
  }
  if (P.welcomeCredits > 0) {
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO credit_ledger (id, player_id, season, kind, credits, label, source_id, created_at) VALUES (?, ?, ?, 'referral_welcome', ?, ?, ?, ?)`
    ).bind(randomId(16), referredId, s, P.welcomeCredits, `Referral welcome`, referredId, now));
    grants.push({ kind: "referral_welcome", credits: P.welcomeCredits });
  }
  // Level 2: the referrer's referrer, only if the referrer is themselves an approved contributor.
  // Always half of this referral's L1; no separate L2 cap (the mid referrer's qualified cap already gates it).
  if (!overCap && l2 > 0) {
    const mid = await env.DB.prepare(
      `SELECT p.referrer_id AS up, (SELECT COUNT(*) FROM signals WHERE player_id = p.id AND status = 'approved') AS approved FROM signal_players p WHERE p.id = ?`
    ).bind(ref.referrer_id).first();
    if (mid && mid.up && Number(mid.approved) > 0 && mid.up !== referredId) {
      stmts.push(env.DB.prepare(
        `INSERT OR IGNORE INTO credit_ledger (id, player_id, season, kind, credits, label, source_id, created_at) VALUES (?, ?, ?, 'referral_l2', ?, ?, ?, ?)`
      ).bind(randomId(16), mid.up, s, l2, `Referral (level 2): @${referred.handle} first approved signal`, referredId, now));
      grants.push({ kind: "referral_l2", credits: l2 });
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { status: overCap ? "over_cap" : "qualified", nth, grants };
}

export async function adminApprove(env, id, body) {
  const tier = String(body.tier || "").toLowerCase();
  if (!SIGNAL_POLICY.tierMultiplier[tier]) return [400, { ok: false, error: "invalid_tier" }];
  const row = await env.DB.prepare(`SELECT s.*, p.handle FROM signals s JOIN signal_players p ON p.id = s.player_id WHERE s.id = ?`).bind(id).first();
  if (!row) return [404, { ok: false, error: "not_found" }];
  if (row.status !== "pending") return [409, { ok: false, error: "not_pending", status: row.status }];
  const outcomes = cleanOutcomes(body.outcomes || {});
  const base = signalBaseCredits(row.signal_type, tier);
  const bonus = signalBonusCredits(outcomes);
  const now = new Date().toISOString();
  const note = String(body.note ?? "").slice(0, 500) || null;
  const upd = await env.DB.prepare(
    `UPDATE signals SET status = 'approved', tier = ?, outcomes_json = ?, base_credits = ?, bonus_credits = ?, reviewer_note = ?, reviewed_at = ? WHERE id = ? AND status = 'pending'`
  ).bind(tier, JSON.stringify(outcomes), base, bonus, note, now, id).run();
  if (!upd.meta?.changes) return [409, { ok: false, error: "not_pending" }];
  const stmts = [
    env.DB.prepare(
      `INSERT OR IGNORE INTO credit_ledger (id, player_id, season, kind, credits, label, source_id, created_at) VALUES (?, ?, ?, 'signal', ?, ?, ?, ?)`
    ).bind(randomId(16), row.player_id, row.season, base, `Matrix Signal: ${row.signal_type} (${tier})`, id, now),
  ];
  if (bonus > 0) {
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO credit_ledger (id, player_id, season, kind, credits, label, source_id, created_at) VALUES (?, ?, ?, 'signal_bonus', ?, ?, ?, ?)`
    ).bind(randomId(16), row.player_id, row.season, bonus, `Matrix Signal outcome bonus`, id, now));
  }
  await env.DB.batch(stmts);
  // Referral qualifies on the referred player's FIRST approved signal.
  const approvedCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM signals WHERE player_id = ? AND status = 'approved'`).bind(row.player_id).first();
  let referral = { status: "none" };
  if (Number(approvedCount?.n) === 1) referral = await qualifyReferral(env, row.player_id, id, row.season, now);
  return [200, { ok: true, id, status: "approved", tier, baseCredits: base, bonusCredits: bonus, referral }];
}

export async function adminReject(env, id, body) {
  const reason = String(body.reason ?? "").trim().slice(0, 300);
  if (reason.length < 3) return [400, { ok: false, error: "reason_required" }];
  const upd = await env.DB.prepare(
    `UPDATE signals SET status = 'rejected', reject_reason = ?, base_credits = 0, bonus_credits = 0, reviewed_at = ? WHERE id = ? AND status = 'pending'`
  ).bind(reason, new Date().toISOString(), id).run();
  if (!upd.meta?.changes) {
    const r = await env.DB.prepare(`SELECT status FROM signals WHERE id = ?`).bind(id).first();
    return r ? [409, { ok: false, error: "not_pending", status: r.status }] : [404, { ok: false, error: "not_found" }];
  }
  return [200, { ok: true, id, status: "rejected" }];
}

/** Update metrics/outcomes on an approved signal (24–72h follow-up). Recomputes the bonus row. */
export async function adminOutcomes(env, id, body) {
  const row = await env.DB.prepare(`SELECT * FROM signals WHERE id = ?`).bind(id).first();
  if (!row) return [404, { ok: false, error: "not_found" }];
  if (row.status !== "approved") return [409, { ok: false, error: "not_approved" }];
  const outcomes = cleanOutcomes(body.outcomes || {});
  const bonus = signalBonusCredits(outcomes);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE signals SET outcomes_json = ?, bonus_credits = ? WHERE id = ?`).bind(JSON.stringify(outcomes), bonus, id),
    env.DB.prepare(`DELETE FROM credit_ledger WHERE kind = 'signal_bonus' AND source_id = ?`).bind(id),
    ...(bonus > 0 ? [env.DB.prepare(
      `INSERT INTO credit_ledger (id, player_id, season, kind, credits, label, source_id, created_at) VALUES (?, ?, ?, 'signal_bonus', ?, ?, ?, ?)`
    ).bind(randomId(16), row.player_id, row.season, bonus, `Matrix Signal outcome bonus`, id, now)] : []),
  ]);
  return [200, { ok: true, id, bonusCredits: bonus }];
}

/** Revoke an approved signal (reviewer error / later-found spam). Removes its Credits; un-qualifies a referral it triggered. */
export async function adminRevoke(env, id, body) {
  const reason = String(body.reason ?? "").trim().slice(0, 300);
  if (reason.length < 3) return [400, { ok: false, error: "reason_required" }];
  const row = await env.DB.prepare(`SELECT * FROM signals WHERE id = ?`).bind(id).first();
  if (!row) return [404, { ok: false, error: "not_found" }];
  if (row.status !== "approved") return [409, { ok: false, error: "not_approved" }];
  const stmts = [
    env.DB.prepare(`UPDATE signals SET status = 'rejected', reject_reason = ?, base_credits = 0, bonus_credits = 0, reviewed_at = ? WHERE id = ?`).bind("revoked: " + reason, new Date().toISOString(), id),
    env.DB.prepare(`DELETE FROM credit_ledger WHERE source_id = ? AND kind IN ('signal','signal_bonus')`).bind(id),
  ];
  const ref = await env.DB.prepare(`SELECT * FROM referrals WHERE qualifying_signal_id = ?`).bind(id).first();
  if (ref) {
    stmts.push(env.DB.prepare(`UPDATE referrals SET status = 'pending', season = NULL, qualified_at = NULL, qualifying_signal_id = NULL WHERE referred_id = ?`).bind(ref.referred_id));
    stmts.push(env.DB.prepare(`DELETE FROM credit_ledger WHERE source_id = ? AND kind LIKE 'referral_%'`).bind(ref.referred_id));
  }
  await env.DB.batch(stmts);
  return [200, { ok: true, id, status: "rejected", referralReset: !!ref }];
}

const LOG_COLUMNS = ["Date", "Contributor", "X Handle", "Target Account", "Target Post URL", "Signal URL", "Signal Type", "Topic", "ONMX Mentioned?", "Why Relevant", "Quality", "Impressions", "Replies Generated", "Likes", "KOL Replied?", "KOL Followed?", "Outcome / Notes", "Reward Status"];
const TYPE_LABEL = { reply: "Reply", quote: "Quote Post", connect: "Connect", discover: "Discover", standalone: "Standalone" };
const TOPIC_LABEL = { rwa: "RWA", bnb: "BNB", treasury: "Treasury", defi: "DeFi", stablecoin: "Stablecoin", credit: "Credit", macro: "Macro", tokenomics: "Tokenomics", data: "Data", other: "Other" };

function csvCell(v) {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // spreadsheet formula-injection guard
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function adminCsv(env, url) {
  const status = String(url.searchParams.get("status") || "all");
  const where = ["pending", "approved", "rejected"].includes(status) ? `WHERE s.status = ?` : "";
  const stmt = env.DB.prepare(`${ADMIN_SELECT} ${where} ORDER BY s.submitted_at ASC LIMIT 5000`);
  const rows = ((where ? await stmt.bind(status).all() : await stmt.all()).results || []).map(adminRow);
  const yn = (b) => (b ? "Yes" : "No");
  const lines = [LOG_COLUMNS.map(csvCell).join(",")];
  for (const r of rows) {
    const o = r.outcomes || {};
    const flags = [o.directInterest && "Direct ONMX interest", o.introduction && "Introduction / partnership lead"].filter(Boolean).join("; ");
    const notes = [flags, o.notes, r.reviewerNote].filter(Boolean).join(" | ");
    const reward = r.status === "approved" ? `Approved: ${r.credits} Credits` : r.status === "rejected" ? `Rejected: ${r.rejectReason || ""}` : "Pending review";
    lines.push([
      r.submittedAt.slice(0, 10), r.handle.slice(1), r.handle, r.targetHandle || "", r.targetUrl || "", r.signalUrl || "",
      TYPE_LABEL[r.type] || r.type, TOPIC_LABEL[r.topic] || r.topic, yn(r.onmxMentioned), r.why,
      r.status === "approved" ? (r.tier || "") : r.status, o.impressions ?? "", o.repliesGenerated ?? "", o.likes ?? "",
      r.outcomes ? yn(o.kolReplied) : "", r.outcomes ? yn(o.kolFollowed) : "", notes, reward,
    ].map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

export async function adminPlayers(env, url) {
  const q = canonHandle(url.searchParams.get("handle") || "");
  const stmt = q
    ? env.DB.prepare(`SELECT id, handle, ref_code, referrer_id, preview, created_at FROM signal_players WHERE handle = ?`).bind(q)
    : env.DB.prepare(`SELECT id, handle, ref_code, referrer_id, preview, created_at FROM signal_players ORDER BY created_at DESC LIMIT 200`);
  const rows = (await stmt.all()).results || [];
  const out = [];
  for (const r of rows) {
    const c = await env.DB.prepare(`SELECT kind, COALESCE(SUM(credits),0) AS c FROM credit_ledger WHERE player_id = ? GROUP BY kind`).bind(r.id).all();
    out.push({ id: r.id, handle: "@" + r.handle, refCode: r.ref_code, referrerId: r.referrer_id, preview: !!r.preview, createdAt: r.created_at,
      ledger: Object.fromEntries((c.results || []).map((x) => [x.kind, Number(x.c)])), referrals: await referralStats(env, r.id) });
  }
  return [200, { ok: true, players: out }];
}

/** Hard-delete a player and all of their rows (test cleanup / handle-squat reset). Referred players keep their account but lose the link. */
export async function adminDeletePlayer(env, id) {
  const p = await env.DB.prepare(`SELECT id FROM signal_players WHERE id = ?`).bind(id).first();
  if (!p) return [404, { ok: false, error: "not_found" }];
  await env.DB.batch(deletePlayerStmts(env, id));
  return [200, { ok: true, deleted: id }];
}

function deletePlayerStmts(env, id) {
  return [
    env.DB.prepare(`DELETE FROM credit_ledger WHERE player_id = ? OR source_id = ? OR source_id IN (SELECT id FROM signals WHERE player_id = ?)`).bind(id, id, id),
    env.DB.prepare(`DELETE FROM referrals WHERE referred_id = ? OR referrer_id = ?`).bind(id, id),
    env.DB.prepare(`DELETE FROM signals WHERE player_id = ?`).bind(id),
    env.DB.prepare(`UPDATE signal_players SET referrer_id = NULL WHERE referrer_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM signal_players WHERE id = ?`).bind(id),
  ];
}

/** Remove every row created in preview mode (run before public launch). */
export async function adminPurgePreview(env) {
  const rows = (await env.DB.prepare(`SELECT id FROM signal_players WHERE preview = 1`).all()).results || [];
  for (const r of rows) await env.DB.batch(deletePlayerStmts(env, r.id));
  const orphan = await env.DB.prepare(`SELECT COUNT(*) AS n FROM signals WHERE preview = 1`).first();
  return [200, { ok: true, deletedPlayers: rows.length, previewSignalsLeft: Number(orphan?.n) || 0 }];
}

// ---------------- public leaderboard (S9) ----------------

/**
 * Season leaderboard ranked by APPROVED Signal Credits for the season (kinds signal + signal_bonus only).
 * Referral Credits never enter the prize ranking; they are included only in lifetimeCredits on a handle lookup.
 * Ties: earlier time the player reached their total (latest qualifying ledger row) ranks first, then handle.
 * Public-safe fields only: handle, rank, seasonCredits (+ lifetimeCredits for a looked-up handle).
 * Preview rows (created while Signals were closed) are excluded unless a valid X-Admin-Preview header is sent.
 * Next-season head starts are a back-end rule and are not applied/exposed here (Season 1 has no prior round).
 */
export function rankRows(rows) {
  const sorted = rows
    .map((r) => ({ handle: r.handle, credits: Math.round((Number(r.credits) || 0) * 100) / 100, reachedAt: String(r.reached_at || ""), playerId: r.player_id }))
    .filter((r) => r.credits > 0)
    .sort((a, b) => b.credits - a.credits || a.reachedAt.localeCompare(b.reachedAt) || a.handle.localeCompare(b.handle));
  sorted.forEach((r, i) => { r.rank = i + 1; });
  return sorted;
}

export async function handleLeaderboard(env, request, url) {
  const hdr = request.headers.get("X-Admin-Preview") || "";
  const preview = !!hdr && (await tokenMatches(env, hdr));
  const s = Number(url.searchParams.get("season")) || season(env);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 20));
  const lookup = canonHandle(url.searchParams.get("handle") || "");
  const ttl = Number(env.LEADERBOARD_CACHE_SECONDS ?? 60);
  const useCache = !preview && ttl > 0 && typeof caches !== "undefined";
  const cacheKey = new Request(`https://cache.onmx.internal/v1/leaderboard?season=${s}&limit=${limit}&handle=${lookup || ""}`);
  if (useCache) {
    const hit = await caches.default.match(cacheKey);
    if (hit) return [200, { ...(await hit.json()), cached: true }];
  }
  const previewFilter = preview ? "" : "AND p.preview = 0";
  const rows = (await env.DB.prepare(
    `SELECT p.id AS player_id, p.handle AS handle, SUM(l.credits) AS credits, MAX(l.created_at) AS reached_at
     FROM credit_ledger l JOIN signal_players p ON p.id = l.player_id
     WHERE l.season = ? AND l.kind IN ('signal','signal_bonus') ${previewFilter}
     GROUP BY p.id, p.handle`
  ).bind(s).all()).results || [];
  const ranked = rankRows(rows);
  const body = {
    ok: true,
    season: s,
    ranking: "approved_signal_credits",
    totalRanked: ranked.length,
    top: ranked.slice(0, limit).map((r) => ({ rank: r.rank, handle: "@" + r.handle, seasonCredits: r.credits })),
    preview,
    generatedAt: new Date().toISOString(),
  };
  if (lookup) {
    const p = await env.DB.prepare(`SELECT id, handle, preview FROM signal_players WHERE handle = ?`).bind(lookup).first();
    if (!p || (p.preview && !preview)) {
      body.player = null;
    } else {
      const life = await env.DB.prepare(
        `SELECT COALESCE(SUM(CASE WHEN kind IN ('signal','signal_bonus') THEN credits END),0) AS sig,
                COALESCE(SUM(CASE WHEN kind LIKE 'referral_%' THEN credits END),0) AS ref
         FROM credit_ledger WHERE player_id = ?`
      ).bind(p.id).first();
      const r = ranked.find((x) => x.playerId === p.id);
      body.player = {
        handle: "@" + p.handle,
        rank: r ? r.rank : null,
        seasonCredits: r ? r.credits : 0,
        lifetimeCredits: Math.round(((Number(life.sig) || 0) + (Number(life.ref) || 0)) * 100) / 100,
      };
    }
  }
  if (useCache) {
    await caches.default.put(cacheKey, new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "cache-control": `max-age=${ttl}` } }));
  }
  return [200, body];
}
