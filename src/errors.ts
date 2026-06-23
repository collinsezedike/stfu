export type FailureType =
  | "blockhash_expired"
  | "fee_too_low"
  | "compute_exceeded"
  | "bundle_rejected"
  | "dropped"
  | "unknown";

/**
 * Maps a raw Solana transaction error object to a human-readable failure category.
 *
 * The error shapes come from the JSON-RPC `TransactionError` type:
 *   { BlockhashNotFound: null }
 *   { InsufficientFundsForFee: null }
 *   { InstructionError: [index, "ComputationalBudgetExceeded"] }
 *   … etc.
 */
export function classifyError(err: unknown): FailureType {
  if (!err || typeof err !== "object") return "unknown";

  const e = err as Record<string, unknown>;

  if ("BlockhashNotFound" in e) return "blockhash_expired";
  if ("InsufficientFundsForFee" in e) return "fee_too_low";

  if ("InstructionError" in e) {
    const ie = e.InstructionError;
    if (Array.isArray(ie) && ie[1] === "ComputationalBudgetExceeded") {
      return "compute_exceeded";
    }
  }

  return "unknown";
}
