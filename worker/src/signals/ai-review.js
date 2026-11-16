/**
 * Shadow-mode AI reply review. Writes signal_scores (and fetched post text).
 * NEVER changes signal status, tier, or credit_ledger. Auto-approve is not
 * implemented: AI_AUTO_APPROVE must stay off or this module hard-fails closed.
 */
import { parseStatusUrl } from "./policy.js";
import { prescreenReply, clusterReplies, applyClusters, PRESCREEN_POLICY } from "./prescreen.js";
import { parseSubstanceResult } from "./substance.js";
import { fetchXPosts } from "./x-fetch.js";
import { DEFAULT_MODEL, renderSubstancePrompt, modelText } from "./prompt.js";

export const DEFAULT_SUBSTANCE_MIN = 80;
export const DEFAULT_CONFIDENCE_MIN = 0.85;
export const SAMPLE_SIZE_TARGET = 150;
export const AUDIT_RATE = 0.1;

export function reviewConfig(env = {}) {
  const mode = String(env.AI_REVIEW_MODE || "off").trim().toLowerCase() === "shadow" ? "shadow" : "off";
  const substanceMin = Number(env.AI_REVIEW_SUBSTANCE_MIN ?? DEFAULT_SUBSTANCE_MIN);
  const confidenceMin = Number(env.AI_REVIEW_CONFIDENCE_MIN ?? DEFAULT_CONFIDENCE_MIN);
  return {
    mode,
    model: String(env.AI_REVIEW_MODEL || DEFAULT_MODEL),
    substanceMin: Number.isFinite(substanceMin) ? substanceMin : DEFAULT_SUBSTANCE_MIN,
    confidenceMin: Number.isFinite(confidenceMin) ? confidenceMin : DEFAULT_CONFIDENCE_MIN,
  };
}

export function reviewPublicConfig(env = {}) {
  const cfg = reviewConfig(env);
  return { mode: cfg.mode, autoApprove: false, model: cfg.model, substanceMin: cfg.substanceMin, confidenceMin: cfg.confidenceMin };
}

export function autoApproveEnabled(env = {}) {
  const v = String(env.AI_AUTO_APPROVE ?? "0").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes" || v === "live";
}

/** Hard-fail closed: auto-approve is not implemented in this branch. */
export function assertAutoApproveDisabled(env = {}) {
  if (autoApproveEnabled(env)) {
    const err = new Error("ai_auto_approve_not_implemented");
    err.status = 500;
    err.error = "ai_auto_approve_not_implemented";
    throw err;
  }
}

export function computeWouldAutoApprove(input = {}, cfg = reviewConfig()) {
  const flags = Array.isArray(input.flags) ? input.flags : [];
  return !!(
    input.prescreenVerdict === "pass" &&
    !input.autoApproveBlocked &&
    Number(input.substance) >= cfg.substanceMin &&
    Number(input.confidence) >= cfg.confidenceMin &&
    flags.length === 0 &&
    input.suggestedTier === "accepted" &&
    (Number(input.humanApprovedCount) || 0) >= 1
  );
}

export function cohenKappa(tp, fp, fn, tn) {
  const n = tp + fp + fn + tn;
  if (n <= 0) return null;
  const po = (tp + tn) / n;
  const pe = (((tp + fp) * (tp + fn)) + ((fn + tn) * (fp + tn))) / (n * n);
  if (pe === 1) return po === 1 ? 1 : 0;
  return (po - pe) / (1 - pe);
}

/**
 * Agreement between the model (or prescreen) and a later human decision.
 * Pending rows are ignored. `modelApprove` is true when suggested_tier is
 * accepted/strong/outstanding (prescreen rejects count as model-reject).
 */
export function agreementStats(rows = []) {
  const reviewed = (rows || []).filter((r) => r.humanStatus === "approved" || r.humanStatus === "rejected");
  let tp = 0, fp = 0, fn = 0, tn = 0;
  let would = 0, wouldReviewed = 0, falseApprovals = 0, falseRejects = 0;
  let agree = 0;
  for (const r of reviewed) {
    const humanApprove = r.humanStatus === "approved";
    const modelApprove = r.prescreenVerdict === "reject" ? false
      : ["accepted", "strong", "outstanding"].includes(r.suggestedTier);
    if (modelApprove && humanApprove) tp++;
    else if (modelApprove && !humanApprove) fp++;
    else if (!modelApprove && humanApprove) fn++;
    else tn++;
    if (modelApprove === humanApprove) agree++;

    const auto = !!r.wouldAutoApprove;
    if (auto) {
      would++;
      wouldReviewed++;
      // False approval: would-auto-approve but human rejected, or human chose a lower tier than accepted (i.e. reject).
      if (!humanApprove) falseApprovals++;
    } else if (humanApprove) {
      falseRejects++;
    }
  }
  // Also count would-auto-approve rows that are still pending in the would total? Rate uses reviewed only.
  const wouldAll = (rows || []).filter((r) => r.wouldAutoApprove).length;
  const faRate = wouldReviewed > 0 ? falseApprovals / wouldReviewed : null;
  const kappa = cohenKappa(tp, fp, fn, tn);
  return {
    reviewed: reviewed.length,
    total: (rows || []).length,
    wouldAutoApprove: wouldAll,
    wouldAutoApproveReviewed: wouldReviewed,
    falseApprovals,
    falseApprovalRate: faRate,
    falseRejects,
    agreement: reviewed.length ? agree / reviewed.length : null,
    kappa,
    confusion: { modelApproveHumanApprove: tp, modelApproveHumanReject: fp, modelRejectHumanApprove: fn, modelRejectHumanReject: tn },
    preliminary: wouldReviewed < SAMPLE_SIZE_TARGET,
    sampleSizeTarget: SAMPLE_SIZE_TARGET,
  };
}

function parseJsonArr(s) {
  try {
    const v = JSON.parse(s || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function scoreRowToPublic(r) {
  if (!r) return null;
  return {
    status: r.status,
    prescreenVersion: r.prescreen_version || null,
    prescreenVerdict: r.prescreen_verdict || null,
    rejectReason: r.reject_reason || null,
    clusterId: r.cluster_id || null,
    clusterSize: r.cluster_size == null ? null : Number(r.cluster_size),
    autoApproveBlocked: !!r.auto_approve_blocked,
    model: r.model || null,
    promptVersion: r.prompt_version || null,
    substance: r.substance == null ? null : Number(r.substance),
    confidence: r.confidence == null ? null : Number(r.confidence),
    suggestedTier: r.suggested_tier || null,
    reasons: parseJsonArr(r.reasons_json),
    flags: parseJsonArr(r.flags_json),
    wouldAutoApprove: !!r.would_auto_approve,
    scoredAt: r.scored_at,
  };
}

async function upsertScore(db, row) {
  await db.prepare(
    `INSERT INTO signal_scores (
        signal_id, status, prescreen_version, prescreen_verdict, reject_reason,
        cluster_id, cluster_size, auto_approve_blocked, model, prompt_version,
        substance, confidence, suggested_tier, reasons_json, flags_json,
        would_auto_approve, scored_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(signal_id) DO UPDATE SET
        status = excluded.status,
        prescreen_version = excluded.prescreen_version,
        prescreen_verdict = excluded.prescreen_verdict,
        reject_reason = excluded.reject_reason,
        cluster_id = excluded.cluster_id,
        cluster_size = excluded.cluster_size,
        auto_approve_blocked = excluded.auto_approve_blocked,
        model = excluded.model,
        prompt_version = excluded.prompt_version,
        substance = excluded.substance,
        confidence = excluded.confidence,
        suggested_tier = excluded.suggested_tier,
        reasons_json = excluded.reasons_json,
        flags_json = excluded.flags_json,
        would_auto_approve = excluded.would_auto_approve,
        scored_at = excluded.scored_at`
  ).bind(
    row.signal_id, row.status, row.prescreen_version, row.prescreen_verdict, row.reject_reason,
    row.cluster_id, row.cluster_size, row.auto_approve_blocked ? 1 : 0, row.model, row.prompt_version,
    row.substance, row.confidence, row.suggested_tier, row.reasons_json, row.flags_json,
    row.would_auto_approve ? 1 : 0, row.scored_at
  ).run();
}

async function ensureTexts(env, signal, io) {
  let replyText = signal.reply_text || "";
  let targetText = signal.target_text || "";
  const needReply = !replyText && !!signal.signal_url && !!extractable(signal.signal_url);
  const needTarget = !targetText && !!signal.target_url && !!extractable(signal.target_url);
  if (!needReply && !needTarget) {
    return { ok: true, replyText, targetText, fetched: false };
  }
  const urls = [];
  if (needReply) urls.push(signal.signal_url);
  if (needTarget) urls.push(signal.target_url);
  const got = await fetchXPosts(urls, {
    bearerToken: env.X_BEARER_TOKEN,
    fetchImpl: io.fetchImpl,
    apiBase: env.X_API_BASE,
  });
  if (!got.ok) return { ok: false, status: got.status, error: got.error, replyText, targetText };
  const replyId = extractable(signal.signal_url);
  const targetId = extractable(signal.target_url);
  if (needReply && got.posts[replyId]) replyText = got.posts[replyId].text || "";
  if (needTarget && got.posts[targetId]) targetText = got.posts[targetId].text || "";
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE signals SET reply_text = ?, target_text = ?, fetched_at = ? WHERE id = ?`
  ).bind(replyText || null, targetText || null, now, signal.id).run();
  return { ok: true, replyText, targetText, fetched: true };
}

function extractable(url) {
  const p = parseStatusUrl(url);
  return p ? p.statusId : null;
}

async function clusterForTarget(env, signal, replyText) {
  if (!signal.target_key) {
    return { clusterId: null, clusterSize: null, autoApproveBlocked: false, verdict: null, reason: null };
  }
  const sibs = (await env.DB.prepare(
    `SELECT s.id, s.player_id, s.reply_text, s.submitted_at
     FROM signals s
     WHERE s.target_key = ? AND s.reply_text IS NOT NULL AND s.reply_text <> ''`
  ).bind(signal.target_key).all()).results || [];
  const items = sibs.map((r) => ({
    id: r.id,
    accountId: r.player_id,
    text: r.id === signal.id ? replyText : r.reply_text,
    createdAt: r.submitted_at,
  }));
  if (!items.some((it) => it.id === signal.id) && replyText) {
    items.push({ id: signal.id, accountId: signal.player_id, text: replyText, createdAt: signal.submitted_at });
  }
  const clusters = clusterReplies(items);
  const overlaid = applyClusters({ [signal.id]: {} }, clusters);
  const mine = overlaid[signal.id] || {};
  // Update cluster fields on already-scored siblings (scores only; never status/credits).
  for (const c of clusters) {
    for (const id of c.memberIds) {
      if (id === signal.id) continue;
      const existing = await env.DB.prepare(`SELECT signal_id, would_auto_approve, prescreen_verdict FROM signal_scores WHERE signal_id = ?`).bind(id).first();
      if (!existing) continue;
      const blocked = 1;
      const reject = c.action === "reject";
      const would = reject ? 0 : existing.would_auto_approve;
      await env.DB.prepare(
        `UPDATE signal_scores
         SET cluster_id = ?, cluster_size = ?, auto_approve_blocked = ?,
             prescreen_verdict = CASE WHEN ? = 1 THEN 'reject' ELSE prescreen_verdict END,
             reject_reason = CASE WHEN ? = 1 THEN 'near_duplicate' ELSE reject_reason END,
             would_auto_approve = ?
         WHERE signal_id = ?`
      ).bind(c.clusterId, c.memberIds.length, blocked, reject ? 1 : 0, reject ? 1 : 0, would, id).run();
    }
  }
  return {
    clusterId: mine.clusterId || null,
    clusterSize: mine.clusterSize ?? null,
    autoApproveBlocked: !!mine.autoApproveBlocked,
    verdict: mine.verdict || null,
    reason: mine.reason || null,
  };
}

async function approvedCount(env, playerId, exceptId) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM signals WHERE player_id = ? AND status = 'approved' AND id <> ?`
  ).bind(playerId, exceptId).first();
  return Number(row?.n) || 0;
}

/**
 * Score one signal in shadow mode. Returns a public score object (or a skip).
 * io: { fetchImpl, aiRun }
 */
export async function scoreSignal(env, signalId, io = {}) {
  assertAutoApproveDisabled(env);
  const cfg = reviewConfig(env);
  if (cfg.mode !== "shadow") return { skipped: true, reason: "off" };

  const signal = await env.DB.prepare(`SELECT * FROM signals WHERE id = ?`).bind(signalId).first();
  if (!signal) return { ok: false, error: "not_found" };

  const fetchIo = { fetchImpl: io.fetchImpl || fetch, aiRun: io.aiRun };
  const texts = await ensureTexts(env, signal, fetchIo);
  if (!texts.ok) {
    const row = {
      signal_id: signal.id,
      status: texts.status,
      prescreen_version: null,
      prescreen_verdict: null,
      reject_reason: texts.status === "no_x_secret" ? "no_x_secret" : (texts.error || texts.status),
      cluster_id: null,
      cluster_size: null,
      auto_approve_blocked: 0,
      model: null,
      prompt_version: null,
      substance: null,
      confidence: null,
      suggested_tier: null,
      reasons_json: null,
      flags_json: null,
      would_auto_approve: 0,
      scored_at: new Date().toISOString(),
    };
    await upsertScore(env.DB, row);
    return { ok: true, score: scoreRowToPublic(row) };
  }

  const replyText = texts.replyText || "";
  const targetText = texts.targetText || "";
  if (!replyText.trim()) {
    const row = {
      signal_id: signal.id,
      status: "no_text",
      prescreen_version: null,
      prescreen_verdict: null,
      reject_reason: "no_text",
      cluster_id: null, cluster_size: null, auto_approve_blocked: 0,
      model: null, prompt_version: null,
      substance: null, confidence: null, suggested_tier: null,
      reasons_json: null, flags_json: null, would_auto_approve: 0,
      scored_at: new Date().toISOString(),
    };
    await upsertScore(env.DB, row);
    return { ok: true, score: scoreRowToPublic(row) };
  }

  const pre = prescreenReply({ replyText, targetText });
  const cluster = await clusterForTarget(env, { ...signal, reply_text: replyText }, replyText);
  let verdict = pre.verdict;
  let reason = pre.reason;
  if (cluster.verdict === "reject") {
    verdict = "reject";
    reason = cluster.reason || "near_duplicate";
  }

  const humanApprovedCount = await approvedCount(env, signal.player_id, signal.id);
  const now = new Date().toISOString();
  const base = {
    signal_id: signal.id,
    prescreen_version: pre.ruleVersion || PRESCREEN_POLICY.version,
    prescreen_verdict: verdict,
    reject_reason: reason,
    cluster_id: cluster.clusterId,
    cluster_size: cluster.clusterSize,
    auto_approve_blocked: cluster.autoApproveBlocked ? 1 : 0,
    model: null,
    prompt_version: null,
    substance: null,
    confidence: null,
    suggested_tier: null,
    reasons_json: null,
    flags_json: null,
    would_auto_approve: 0,
    scored_at: now,
  };

  if (verdict !== "pass") {
    const row = { ...base, status: "prescreen_reject" };
    await upsertScore(env.DB, row);
    return { ok: true, score: scoreRowToPublic(row) };
  }

  const run = fetchIo.aiRun || (env.AI && typeof env.AI.run === "function" ? (model, input) => env.AI.run(model, input) : null);
  if (!run) {
    const row = { ...base, status: "ai_failed", reject_reason: "ai_binding_missing" };
    await upsertScore(env.DB, row);
    return { ok: true, score: scoreRowToPublic(row) };
  }

  const { messages, promptVersion } = renderSubstancePrompt(targetText, replyText);
  let raw;
  try {
    raw = await run(cfg.model, { messages, temperature: 0, max_tokens: 512 });
  } catch (err) {
    const row = { ...base, status: "ai_failed", model: cfg.model, prompt_version: promptVersion, reject_reason: String(err && (err.message || err)).slice(0, 300) };
    await upsertScore(env.DB, row);
    return { ok: true, score: scoreRowToPublic(row) };
  }

  const parsed = parseSubstanceResult(modelText(raw));
  if (!parsed.ok) {
    const row = { ...base, status: "parse_failed", model: cfg.model, prompt_version: promptVersion, reject_reason: parsed.error };
    await upsertScore(env.DB, row);
    return { ok: true, score: scoreRowToPublic(row) };
  }

  const v = parsed.value;
  const would = computeWouldAutoApprove({
    prescreenVerdict: verdict,
    autoApproveBlocked: cluster.autoApproveBlocked,
    substance: v.substance,
    confidence: v.confidence,
    flags: v.flags,
    suggestedTier: v.suggested_tier,
    humanApprovedCount,
  }, cfg);

  const row = {
    ...base,
    status: "scored",
    model: cfg.model,
    prompt_version: v.prompt_version || promptVersion,
    substance: v.substance,
    confidence: v.confidence,
    suggested_tier: v.suggested_tier,
    reasons_json: JSON.stringify(v.reasons || []),
    flags_json: JSON.stringify(v.flags || []),
    would_auto_approve: would ? 1 : 0,
  };
  await upsertScore(env.DB, row);
  return { ok: true, score: scoreRowToPublic(row) };
}

/** Score pending signals (admin). Does not change status or credits. */
export async function scorePending(env, { ids, limit = 50 } = {}, io = {}) {
  assertAutoApproveDisabled(env);
  const cfg = reviewConfig(env);
  if (cfg.mode !== "shadow") return { ok: false, error: "ai_review_off", mode: cfg.mode };

  let rows;
  if (ids && ids.length) {
    const list = ids.slice(0, 100).filter((id) => typeof id === "string" && /^[a-f0-9]{32}$/.test(id));
    if (!list.length) return { ok: false, error: "invalid_ids" };
    const placeholders = list.map(() => "?").join(",");
    rows = (await env.DB.prepare(`SELECT id FROM signals WHERE id IN (${placeholders})`).bind(...list).all()).results || [];
  } else {
    const cap = Math.min(100, Math.max(1, Number(limit) || 50));
    rows = (await env.DB.prepare(
      `SELECT s.id FROM signals s
       LEFT JOIN signal_scores sc ON sc.signal_id = s.id
       WHERE s.status = 'pending' AND (sc.signal_id IS NULL OR sc.status IN ('no_x_secret','fetch_failed','no_text','ai_failed','parse_failed'))
       ORDER BY s.submitted_at ASC LIMIT ${cap}`
    ).all()).results || [];
  }
  const results = [];
  for (const r of rows) {
    results.push(await scoreSignal(env, r.id, io));
  }
  return { ok: true, mode: "shadow", scored: results.length, results };
}

export async function loadAgreementRows(env) {
  const rows = (await env.DB.prepare(
    `SELECT sc.would_auto_approve, sc.suggested_tier, sc.prescreen_verdict, sc.reject_reason, sc.status AS score_status,
            s.status AS human_status, s.tier AS human_tier
     FROM signal_scores sc JOIN signals s ON s.id = sc.signal_id`
  ).all()).results || [];
  return rows.map((r) => ({
    wouldAutoApprove: !!r.would_auto_approve,
    suggestedTier: r.suggested_tier,
    prescreenVerdict: r.prescreen_verdict,
    rejectReason: r.reject_reason,
    scoreStatus: r.score_status,
    humanStatus: r.human_status,
    humanTier: r.human_tier,
  }));
}

export async function adminAgreementStats(env) {
  const cfg = reviewConfig(env);
  const stats = agreementStats(await loadAgreementRows(env));
  return { ok: true, mode: cfg.mode, autoApprove: false, thresholds: { substanceMin: cfg.substanceMin, confidenceMin: cfg.confidenceMin, acceptedTierOnly: true }, ...stats };
}
