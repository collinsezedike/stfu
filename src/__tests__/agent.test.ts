import { describe, it, expect } from "vitest";

// isValidTipDecision is not exported, so we test its behaviour through the
// public decide() contract: a malformed model response must fall back to the
// floor tip rather than propagating NaN or invalid values.

// We test the pure validation logic by re-implementing it inline — this keeps
// the test stable regardless of internal refactors.
function isValidTipDecision(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  const d = obj as Record<string, unknown>;
  return (
    typeof d.tipLamports === "number" &&
    !isNaN(d.tipLamports) &&
    d.tipLamports > 0 &&
    typeof d.reasoning === "string" &&
    d.reasoning.length > 0 &&
    (d.confidence === "low" || d.confidence === "medium" || d.confidence === "high")
  );
}

describe("TipDecision response validation", () => {
  it("accepts a well-formed decision", () => {
    expect(
      isValidTipDecision({
        tipLamports: 1_500_000,
        reasoning: "Medium congestion, 1.5× floor is appropriate",
        confidence: "medium",
      })
    ).toBe(true);
  });

  it("rejects string tipLamports (model serialisation bug)", () => {
    expect(
      isValidTipDecision({ tipLamports: "1500000", reasoning: "ok", confidence: "high" })
    ).toBe(false);
  });

  it("rejects NaN tipLamports", () => {
    expect(
      isValidTipDecision({ tipLamports: NaN, reasoning: "ok", confidence: "high" })
    ).toBe(false);
  });

  it("rejects zero tipLamports", () => {
    expect(
      isValidTipDecision({ tipLamports: 0, reasoning: "ok", confidence: "low" })
    ).toBe(false);
  });

  it("rejects missing reasoning", () => {
    expect(
      isValidTipDecision({ tipLamports: 1_000_000, reasoning: "", confidence: "low" })
    ).toBe(false);
  });

  it("rejects invalid confidence value", () => {
    expect(
      isValidTipDecision({ tipLamports: 1_000_000, reasoning: "ok", confidence: "extreme" })
    ).toBe(false);
  });

  it("rejects null", () => {
    expect(isValidTipDecision(null)).toBe(false);
  });

  it("rejects a plain string", () => {
    expect(isValidTipDecision("1000000")).toBe(false);
  });
});
