/**
 * Validator for substance-v1 model output. No model calls live here.
 * Dashboard Manager owns the Workers AI invocation and shadow-mode logging.
 *
 * Prompt file: src/signals/prompts/substance-v1.txt (prompt_version: substance-v1).
 * Note: automation may only act on suggested_tier "accepted"; strong / outstanding
 * and outcome bonuses stay with a human reviewer.
 */

export const SUBSTANCE_PROMPT_VERSION = "substance-v1";
export const SUBSTANCE_TIERS = Object.freeze(["reject", "accepted", "strong", "outstanding"]);
export const SUBSTANCE_FLAGS = Object.freeze(["off_topic", "promo", "injection", "factual_claim", "hostile"]);

const TIER_SET = new Set(SUBSTANCE_TIERS);
const FLAG_SET = new Set(SUBSTANCE_FLAGS);

function extractJsonObject(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    /* fall through and try to slice the first object, including fenced output */
  }
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : raw;
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function clampInt(n, lo, hi) {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.min(hi, Math.max(lo, Math.round(x)));
}

function clampNum(n, lo, hi) {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Parse and clamp a substance-v1 model JSON payload.
 * @param {string} jsonText
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function parseSubstanceResult(jsonText) {
  const obj = extractJsonObject(jsonText);
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, error: "invalid_json" };
  }

  const substance = clampInt(obj.substance, 0, 100);
  if (substance == null) return { ok: false, error: "invalid_substance" };

  if (typeof obj.engages_post !== "boolean") return { ok: false, error: "invalid_engages_post" };

  const confidence = clampNum(obj.confidence, 0, 1);
  if (confidence == null) return { ok: false, error: "invalid_confidence" };

  const suggested_tier = String(obj.suggested_tier ?? "");
  if (!TIER_SET.has(suggested_tier)) return { ok: false, error: "invalid_suggested_tier" };

  const reasonsIn = Array.isArray(obj.reasons) ? obj.reasons : null;
  if (!reasonsIn) return { ok: false, error: "invalid_reasons" };
  const reasons = reasonsIn
    .slice(0, 3)
    .map((r) => String(r ?? "").trim().slice(0, 200))
    .filter(Boolean);

  const flagsIn = Array.isArray(obj.flags) ? obj.flags : null;
  if (!flagsIn) return { ok: false, error: "invalid_flags" };
  const seen = new Set();
  const flags = [];
  for (const f of flagsIn) {
    const name = String(f ?? "");
    if (FLAG_SET.has(name) && !seen.has(name)) {
      seen.add(name);
      flags.push(name);
    }
  }

  return {
    ok: true,
    value: {
      substance,
      engages_post: obj.engages_post,
      confidence,
      suggested_tier,
      reasons,
      flags,
      prompt_version: SUBSTANCE_PROMPT_VERSION,
    },
  };
}
