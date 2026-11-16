import { describe, it, expect } from "vitest";
import { parseSubstanceResult, SUBSTANCE_PROMPT_VERSION } from "../src/signals/substance.js";

describe("substance-v1 prompt version", () => {
  it("exports the version matching the prompt file", () => {
    expect(SUBSTANCE_PROMPT_VERSION).toBe("substance-v1");
  });
});

describe("parseSubstanceResult", () => {
  const valid = {
    substance: 64,
    engages_post: true,
    confidence: 0.8,
    suggested_tier: "accepted",
    reasons: ["cites the day-60 tranche", "asks a useful follow-up"],
    flags: [],
  };

  it("accepts a valid payload", () => {
    const r = parseSubstanceResult(JSON.stringify(valid));
    expect(r.ok).toBe(true);
    expect(r.value.substance).toBe(64);
    expect(r.value.engages_post).toBe(true);
    expect(r.value.confidence).toBe(0.8);
    expect(r.value.suggested_tier).toBe("accepted");
    expect(r.value.reasons).toEqual(valid.reasons);
    expect(r.value.flags).toEqual([]);
    expect(r.value.prompt_version).toBe("substance-v1");
  });

  it("clamps substance and confidence into range", () => {
    const r = parseSubstanceResult(JSON.stringify({ ...valid, substance: 150, confidence: 1.5 }));
    expect(r.ok).toBe(true);
    expect(r.value.substance).toBe(100);
    expect(r.value.confidence).toBe(1);
    const r2 = parseSubstanceResult(JSON.stringify({ ...valid, substance: -4, confidence: -0.2 }));
    expect(r2.value.substance).toBe(0);
    expect(r2.value.confidence).toBe(0);
  });

  it("keeps at most 3 reasons and drops unknown flags", () => {
    const r = parseSubstanceResult(JSON.stringify({
      ...valid,
      reasons: ["a", "b", "c", "d"],
      flags: ["promo", "not_a_flag", "hostile", "promo"],
    }));
    expect(r.ok).toBe(true);
    expect(r.value.reasons).toEqual(["a", "b", "c"]);
    expect(r.value.flags).toEqual(["promo", "hostile"]);
  });

  it("parses JSON wrapped in a markdown fence", () => {
    const r = parseSubstanceResult("```json\n" + JSON.stringify(valid) + "\n```");
    expect(r.ok).toBe(true);
    expect(r.value.substance).toBe(64);
  });

  it("rejects invalid JSON, missing fields, and bad tiers", () => {
    expect(parseSubstanceResult("not json").ok).toBe(false);
    expect(parseSubstanceResult(JSON.stringify({ ...valid, suggested_tier: "legendary" })).error).toBe("invalid_suggested_tier");
    expect(parseSubstanceResult(JSON.stringify({ ...valid, engages_post: "yes" })).error).toBe("invalid_engages_post");
    expect(parseSubstanceResult(JSON.stringify({ ...valid, substance: "nope" })).error).toBe("invalid_substance");
    const { reasons, ...noReasons } = valid;
    expect(parseSubstanceResult(JSON.stringify(noReasons)).error).toBe("invalid_reasons");
  });
});
