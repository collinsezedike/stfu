import {
  Connection,
  TransactionSignature,
  TransactionConfirmationStatus,
} from "@solana/web3.js";
import { EventEmitter } from "node:events";
import { classifyError, FailureType } from "../errors.js";

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
  failureType?: FailureType;
  retryCount?: number;
}

// Drop a tx if it hasn't processed within this many slots (~60s at 400ms/slot)
const DROP_TIMEOUT_SLOTS = 150;

// Polling interval for the RPC fallback — WebSocket subscriptions are the primary path
const POLL_INTERVAL_MS = 5_000;

export class LifecycleTracker extends EventEmitter {
  private tracked = new Map<TransactionSignature, TxLifecycle>();
  private subscriptions = new Map<TransactionSignature, number[]>();
  private timer: NodeJS.Timeout | null = null;
  private currentSlot = 0;

  constructor(private readonly connection: Connection) {
    super();
  }

  /** Call this whenever a new processed slot arrives from the Geyser stream. */
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
    this.setupSubscriptions(lifecycle);
    this.emit("submitted", lifecycle);
    console.log(`[tracker] Tracking ${signature.slice(0, 8)}… (slot ${submittedSlot})`);
    return lifecycle;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    console.log("[tracker] Started (WebSocket primary, RPC fallback every 5s)");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const sig of [...this.subscriptions.keys()]) {
      this.cleanupSubscriptions(sig);
    }
  }

  getAll(): TxLifecycle[] {
    return [...this.tracked.values()];
  }

  /**
   * Opens three WebSocket signature subscriptions (processed / confirmed / finalized).
   * Each subscription fires once when the tx reaches that commitment level, then
   * auto-removes. The polling fallback in poll() catches anything the WebSocket misses
   * (e.g. after a connection drop) and handles drop detection.
   */
  private setupSubscriptions(lifecycle: TxLifecycle): void {
    const sig = lifecycle.signature;
    const subs: number[] = [];

    subs.push(
      this.connection.onSignature(
        sig,
        (_result, ctx) => {
          // Errors are handled in the finalized subscription where they're definitive
          if (lifecycle.status === "submitted") {
            this.advance(lifecycle, "processed", ctx.slot, Date.now());
          }
        },
        "processed"
      )
    );

    subs.push(
      this.connection.onSignature(
        sig,
        (result, ctx) => {
          if (result.err) return;
          // advance() cascades: if still "submitted" it will set processed first
          this.advance(lifecycle, "confirmed", ctx.slot, Date.now());
        },
        "confirmed"
      )
    );

    subs.push(
      this.connection.onSignature(
        sig,
        (result, ctx) => {
          const now = Date.now();
          if (result.err) {
            if (lifecycle.status !== "failed" && lifecycle.status !== "dropped") {
              lifecycle.status = "failed";
              lifecycle.error = JSON.stringify(result.err);
              lifecycle.failureType = classifyError(result.err);
              this.emit("failed", lifecycle);
              this.cleanupSubscriptions(sig);
              console.error(
                `[tracker] ${sig.slice(0, 8)}… FAILED (ws): ${lifecycle.error}`
              );
            }
            return;
          }
          // Cascade through any missed intermediate stages
          this.advance(lifecycle, "finalized", ctx.slot, now);
          this.cleanupSubscriptions(sig);
        },
        "finalized"
      )
    );

    this.subscriptions.set(sig, subs);
  }

  private cleanupSubscriptions(sig: TransactionSignature): void {
    const subs = this.subscriptions.get(sig);
    if (!subs) return;
    for (const id of subs) {
      this.connection.removeSignatureListener(id).catch(() => {});
    }
    this.subscriptions.delete(sig);
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
        if (
          this.currentSlot > 0 &&
          lifecycle.submittedSlot > 0 &&
          this.currentSlot > lifecycle.submittedSlot &&
          this.currentSlot - lifecycle.submittedSlot > DROP_TIMEOUT_SLOTS
        ) {
          if (lifecycle.status === "submitted") {
            lifecycle.status = "dropped";
            lifecycle.failureType = "dropped";
            this.emit("dropped", lifecycle);
            this.cleanupSubscriptions(lifecycle.signature);
            console.warn(
              `[tracker] ${lifecycle.signature.slice(0, 8)}… DROPPED after ${DROP_TIMEOUT_SLOTS} slots`
            );
          }
        }
        continue;
      }

      if (status.err) {
        if (lifecycle.status !== "failed") {
          lifecycle.status = "failed";
          lifecycle.error = JSON.stringify(status.err);
          lifecycle.failureType = classifyError(status.err);
          this.emit("failed", lifecycle);
          this.cleanupSubscriptions(lifecycle.signature);
          console.error(
            `[tracker] ${lifecycle.signature.slice(0, 8)}… FAILED: ${lifecycle.error}`
          );
        }
        continue;
      }

      if (status.confirmationStatus) {
        this.advance(lifecycle, status.confirmationStatus, status.slot, now);
      }
    }
  }

  private advance(
    lifecycle: TxLifecycle,
    confirmationStatus: TransactionConfirmationStatus,
    slot: number,
    now: number
  ): void {
    const sig = lifecycle.signature.slice(0, 8) + "…";

    // Plain `if` blocks (not `else if`) so a single call with "finalized" on a
    // still-"submitted" tx cascades through all three stages in one pass.
    if (
      (confirmationStatus === "processed" ||
        confirmationStatus === "confirmed" ||
        confirmationStatus === "finalized") &&
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
      // processedAt is always set just above in the cascade, so this delta is safe
      const delta = lifecycle.confirmedAt - lifecycle.processedAt!;
      this.emit("confirmed", lifecycle);
      console.log(`[tracker] ${sig} CONFIRMED at slot ${slot} (+${delta}ms from processed)`);
    }

    if (confirmationStatus === "finalized" && lifecycle.status === "confirmed") {
      lifecycle.status = "finalized";
      lifecycle.finalizedAt = now;
      lifecycle.finalizedSlot = slot;
      this.emit("finalized", lifecycle);
      console.log(
        `[tracker] ${sig} FINALIZED at slot ${slot} | ` +
          `processed→confirmed: ${lifecycle.confirmedAt! - lifecycle.processedAt!}ms`
      );
    }
  }
}
