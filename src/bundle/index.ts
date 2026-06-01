import {
  Connection,
  Keypair,
  PublicKey,
  TransactionSignature,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { searcherClient, SearcherClient } from "jito-ts/dist/sdk/block-engine/searcher.js";
import { Bundle } from "jito-ts/dist/sdk/block-engine/types.js";
import { EventEmitter } from "node:events";

const BUNDLE_TX_LIMIT = 5;

export interface BundleSubmission {
  uuid: string;
  signatures: TransactionSignature[];
  tipLamports: number;
  submittedSlot: number;
  submittedAt: number;
}

export interface BundleResult {
  uuid: string;
  accepted: boolean;
  slot?: number;
  reason?: string;
}

export class BundleSubmitter extends EventEmitter {
  private client: SearcherClient;
  private cancelResultSub: (() => void) | null = null;

  constructor(
    private readonly connection: Connection,
    private readonly payer: Keypair,
    blockEngineUrl: string
  ) {
    super();
    this.client = searcherClient(blockEngineUrl, payer);
    this.subscribeToResults();
  }

  private subscribeToResults(): void {
    this.cancelResultSub = this.client.onBundleResult(
      (result) => {
        const accepted = "accepted" in result;
        const rejected = "rejected" in result;

        const bundleResult: BundleResult = {
          uuid: result.bundleId,
          accepted,
          reason: rejected
            ? JSON.stringify((result as { rejected: unknown }).rejected)
            : undefined,
        };

        this.emit(accepted ? "accepted" : "rejected", bundleResult);

        if (accepted) {
          console.log(`[bundle] Accepted: ${result.bundleId}`);
        } else {
          console.warn(`[bundle] Rejected: ${result.bundleId} — ${bundleResult.reason}`);
        }
      },
      (err) => {
        console.error("[bundle] Result stream error:", err.message);
        this.emit("error", err);
      }
    );
  }

  async getTipAccounts(): Promise<PublicKey[]> {
    const result = await this.client.getTipAccounts();
    if (!result.ok) throw result.error;
    return result.value.map((addr) => new PublicKey(addr));
  }

  async getNextLeader(): Promise<{ currentSlot: number; nextLeaderSlot: number; nextLeaderIdentity: string }> {
    const result = await this.client.getNextScheduledLeader();
    if (!result.ok) throw result.error;
    return result.value;
  }

  async submit(
    transactions: VersionedTransaction[],
    tipLamports: number,
    currentSlot: number
  ): Promise<BundleSubmission> {
    if (transactions.length === 0) throw new Error("No transactions to bundle");
    // BUNDLE_TX_LIMIT is 5 total including the tip tx, so user txs are capped at 4.
    // >= rather than > because addTipTx will push the count to BUNDLE_TX_LIMIT + 1.
    if (transactions.length >= BUNDLE_TX_LIMIT) {
      throw new Error(`Bundle exceeds ${BUNDLE_TX_LIMIT - 1} user tx limit (tip tx occupies one slot)`);
    }

    const tipAccounts = await this.getTipAccounts();
    const tipAccount = tipAccounts[Math.floor(Math.random() * tipAccounts.length)]!;

    const { blockhash } = await this.connection.getLatestBlockhash("confirmed");

    const b = new Bundle(transactions, BUNDLE_TX_LIMIT);
    const withTip = b.addTipTx(this.payer, tipLamports, tipAccount, blockhash);
    if (withTip instanceof Error) throw withTip;

    const result = await this.client.sendBundle(withTip);
    if (!result.ok) throw result.error;

    const uuid = result.value;
    const signatures = transactions.map((tx) => {
      const sig = tx.signatures[0];
      if (!sig) throw new Error("Transaction has no signature");
      return bs58.encode(sig);
    });

    const submission: BundleSubmission = {
      uuid,
      signatures,
      tipLamports,
      submittedSlot: currentSlot,
      submittedAt: Date.now(),
    };

    this.emit("submitted", submission);
    console.log(
      `[bundle] Submitted ${uuid} | ${transactions.length} tx(s) + tip ${tipLamports} lamports | slot ${currentSlot}`
    );

    return submission;
  }

  destroy(): void {
    this.cancelResultSub?.();
    this.cancelResultSub = null;
  }
}
