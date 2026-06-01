import {
  Connection,
  TransactionSignature,
  TransactionConfirmationStatus,
} from "@solana/web3.js";
import { EventEmitter } from "node:events";

export type TxStatus =
  | "submitted"
  | "processed"
  | "confirmed"
  | "finalized"
  | "failed"
  | "dropped";

export interface TxLifecycle {
  signature: TransactionSignature;
  status: TxStatus;
  submittedAt: number;
  submittedSlot: number;
  processedAt?: number;
  processedSlot?: number;
  confirmedAt?: number;
  confirmedSlot?: number;
  finalizedAt?: number;
  finalizedSlot?: number;
  error?: string;
}

// Drop a tx if it hasn't processed within this many slots (~60s at 400ms/slot)
const DROP_TIMEOUT_SLOTS = 150;

// How often to poll getSignatureStatuses
const POLL_INTERVAL_MS = 1_000;

export class LifecycleTracker extends EventEmitter {
  private tracked = new Map<TransactionSignature, TxLifecycle>();
  private timer: NodeJS.Timeout | null = null;
  private currentSlot = 0;

  constructor(private readonly connection: Connection) {
    super();
  }

  /** Call this whenever a new slot arrives from the Geyser stream. */
  updateSlot(slot: number): void {
    this.currentSlot = slot;
  }

  /** Begin tracking a transaction that was just submitted. */
  track(signature: TransactionSignature, submittedSlot: number): TxLifecycle {
    const lifecycle: TxLifecycle = {
      signature,
      status: "submitted",
      submittedAt: Date.now(),
      submittedSlot,
    };
    this.tracked.set(signature, lifecycle);
    this.emit("submitted", lifecycle);
    console.log(`[tracker] Tracking ${signature.slice(0, 8)}… (slot ${submittedSlot})`);
    return lifecycle;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    console.log("[tracker] Polling for signature statuses...");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getAll(): TxLifecycle[] {
    return [...this.tracked.values()];
  }

  private async poll(): Promise<void> {
    const pending = [...this.tracked.values()].filter(
      (tx) => tx.status !== "finalized" && tx.status !== "failed" && tx.status !== "dropped"
    );
    if (pending.length === 0) return;

    const signatures = pending.map((tx) => tx.signature);

    let statuses;
    try {
      const result = await this.connection.getSignatureStatuses(signatures, {
        searchTransactionHistory: true,
      });
      statuses = result.value;
    } catch (err) {
      console.error("[tracker] getSignatureStatuses failed:", err);
      return;
    }

    const now = Date.now();

    for (let i = 0; i < pending.length; i++) {
      const lifecycle = pending[i]!;
      const status = statuses[i];

      if (!status) {
        // No status yet — check if it's been too long
        if (
          this.currentSlot > 0 &&
          this.currentSlot - lifecycle.submittedSlot > DROP_TIMEOUT_SLOTS
        ) {
          lifecycle.status = "dropped";
          this.emit("dropped", lifecycle);
          console.warn(
            `[tracker] ${lifecycle.signature.slice(0, 8)}… DROPPED after ${DROP_TIMEOUT_SLOTS} slots`
          );
        }
        continue;
      }

      if (status.err) {
        lifecycle.status = "failed";
        lifecycle.error = JSON.stringify(status.err);
        this.emit("failed", lifecycle);
        console.error(
          `[tracker] ${lifecycle.signature.slice(0, 8)}… FAILED: ${lifecycle.error}`
        );
        continue;
      }

      this.advance(lifecycle, status.confirmationStatus ?? null, status.slot, now);
    }
  }

  private advance(
    lifecycle: TxLifecycle,
    confirmationStatus: TransactionConfirmationStatus | null,
    slot: number,
    now: number
  ): void {
    const sig = lifecycle.signature.slice(0, 8) + "…";

    // These are plain `if` blocks, not `else if`, so a single poll returning
    // `finalized` on a still-`submitted` tx cascades through all three stages
    // in one call. This handles the common case where confirmation outpaces
    // our 1s poll interval and we skip intermediate states entirely.
    if (
      (confirmationStatus === "processed" || confirmationStatus === "confirmed" || confirmationStatus === "finalized") &&
      lifecycle.status === "submitted"
    ) {
      lifecycle.status = "processed";
      lifecycle.processedAt = now;
      lifecycle.processedSlot = slot;
      this.emit("processed", lifecycle);
      console.log(`[tracker] ${sig} PROCESSED at slot ${slot}`);
    }

    if (
      (confirmationStatus === "confirmed" || confirmationStatus === "finalized") &&
      lifecycle.status === "processed"
    ) {
      lifecycle.status = "confirmed";
      lifecycle.confirmedAt = now;
      lifecycle.confirmedSlot = slot;
      const delta = lifecycle.confirmedAt - (lifecycle.processedAt ?? lifecycle.submittedAt);
      this.emit("confirmed", lifecycle);
      console.log(`[tracker] ${sig} CONFIRMED at slot ${slot} (+${delta}ms from processed)`);
    }

    if (
      confirmationStatus === "finalized" &&
      lifecycle.status === "confirmed"
    ) {
      lifecycle.status = "finalized";
      lifecycle.finalizedAt = now;
      lifecycle.finalizedSlot = slot;
      this.emit("finalized", lifecycle);
      console.log(
        `[tracker] ${sig} FINALIZED at slot ${slot} | ` +
        `processed→confirmed: ${(lifecycle.confirmedAt! - lifecycle.processedAt!)}ms`
      );
    }
  }
}
