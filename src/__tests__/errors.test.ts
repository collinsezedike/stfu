import { describe, it, expect } from "vitest";
import { classifyError } from "../errors.js";

describe("classifyError", () => {
  it("classifies BlockhashNotFound as blockhash_expired", () => {
    expect(classifyError({ BlockhashNotFound: null })).toBe("blockhash_expired");
  });

  it("classifies InsufficientFundsForFee as fee_too_low", () => {
    expect(classifyError({ InsufficientFundsForFee: null })).toBe("fee_too_low");
  });

  it("classifies InstructionError ComputationalBudgetExceeded as compute_exceeded", () => {
    expect(
      classifyError({ InstructionError: [0, "ComputationalBudgetExceeded"] })
    ).toBe("compute_exceeded");
  });

  it("returns unknown for other InstructionError variants", () => {
    expect(
      classifyError({ InstructionError: [0, "InvalidAccountData"] })
    ).toBe("unknown");
  });

  it("returns unknown for unrecognised error shapes", () => {
    expect(classifyError({ SomeOtherError: true })).toBe("unknown");
    expect(classifyError(null)).toBe("unknown");
    expect(classifyError("string error")).toBe("unknown");
    expect(classifyError(42)).toBe("unknown");
  });
});
