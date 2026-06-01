/**
 * STFU end-to-end demo
 *
 * Submits a 1-lamport self-transfer as a Jito bundle and prints the full
 * lifecycle log (slot numbers + timestamps) as it advances to finality.
 * Paste this output into your submission as proof of a live mainnet run.
 *
 * Usage: pnpm demo
 */

import "dotenv/config";
import {
  Connection,
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { SlotStream, SlotUpdate } from "./stream/index.js";
import { LifecycleTracker, TxLifecycle } from "./tracker/index.js";
import { BundleSubmitter, BundleSubmission, BundleResult } from "./bundle/index.js";
import { TipAgent } from "./agent/index.js";

const FINALITY_TIMEOUT_MS = 120_000;

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function formatSlotDelta(a?: number, b?: number): string {
  if (a == null || b == null) return "—";
  return `+${b - a}ms`;
}

async function waitForSlot(stream: SlotStream): Promise<number> {
  return new Promise((resolve) => {
    const handler = (update: SlotUpdate) => {
      if (update.status === "processed") {
        stream.off("slot", handler);
        resolve(update.slot);
      }
    };
    stream.on("slot", handler);
  });
}

async function main() {
  const endpoint       = requireEnv("GEYSER_ENDPOINT");
  const token          = process.env["GEYSER_TOKEN"] ?? "";
  const rpcUrl         = process.env["RPC_URL"] ?? "https://api.mainnet-beta.solana.com";
  const blockEngineUrl = requireEnv("JITO_BLOCK_ENGINE_URL");
  const privateKey     = requireEnv("WALLET_PRIVATE_KEY");
  const anthropicKey   = requireEnv("ANTHROPIC_API_KEY");
  const tipFloor       = parseInt(process.env["TIP_FLOOR_LAMPORTS"] ?? "1000000", 10);

  const payer      = Keypair.fromSecretKey(bs58.decode(privateKey));
  const connection = new Connection(rpcUrl, "confirmed");

  console.log("━".repeat(60));
  console.log("  STFU — Smart Transaction Forwarding Unit");
  console.log("  End-to-End Demo");
  console.log("━".repeat(60));
  console.log(`  Wallet : ${payer.publicKey.toBase58()}`);
  console.log(`  RPC    : ${rpcUrl}`);
  console.log(`  Engine : ${blockEngineUrl}`);
  console.log("━".repeat(60));

  // --- Boot infrastructure ---
  const stream    = new SlotStream(endpoint, token);
  const tracker   = new LifecycleTracker(connection);
  const submitter = new BundleSubmitter(connection, payer, blockEngineUrl);
  const agent     = new TipAgent(connection, anthropicKey, tipFloor);

  stream.on("error", (err: Error) => console.error("[stream]", err.message));
  stream.on("reconnecting", (n: number) => console.warn(`[stream] Reconnecting (attempt ${n})`));

  let currentSlot = 0;
  stream.on("slot", (update: SlotUpdate) => {
    if (update.status === "processed") {
      currentSlot = update.slot;
      tracker.updateSlot(update.slot);
    }
  });

  tracker.start();
  stream.start(); // intentionally not awaited — runs in background

  // Wait for first slot so we have a current slot number
  console.log("\n[1/5] Connecting to Geyser stream...");
  currentSlot = await waitForSlot(stream);
  console.log(`      ✓ Live at slot ${currentSlot}`);

  // --- Get next leader context ---
  console.log("\n[2/5] Fetching next Jito leader...");
  const leader = await submitter.getNextLeader();
  console.log(`      ✓ Next leader slot : ${leader.nextLeaderSlot}`);
  console.log(`        Identity         : ${leader.nextLeaderIdentity}`);
  console.log(`        Slots away       : ${leader.nextLeaderSlot - currentSlot}`);

  // --- AI tip decision ---
  console.log("\n[3/5] Running tip agent...");
  const context  = await agent.gatherContext(currentSlot, leader.nextLeaderSlot);
  const decision = await agent.decide(context);
  console.log(`      ✓ Tip       : ${decision.tipLamports.toLocaleString()} lamports`);
  console.log(`        Confidence: ${decision.confidence}`);
  console.log(`        Reasoning : "${decision.reasoning}"`);

  // --- Build transaction ---
  console.log("\n[4/5] Building bundle...");
  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  const ix = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey:   payer.publicKey,
    lamports:   1,
  });

  const message = new TransactionMessage({
    payerKey:            payer.publicKey,
    recentBlockhash:     blockhash,
    instructions:        [ix],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([payer]);

  const sig = bs58.encode(tx.signatures[0]!);
  console.log(`      ✓ Signature : ${sig}`);
  console.log(`        Blockhash : ${blockhash}`);

  // --- Submit ---
  console.log("\n[5/5] Submitting bundle to Jito...");

  submitter.on("accepted", (result: BundleResult) => {
    console.log(`\n      ✓ Bundle ACCEPTED — uuid: ${result.uuid}`);
  });

  submitter.on("rejected", (result: BundleResult) => {
    console.warn(`\n      ✗ Bundle REJECTED — ${result.reason}`);
  });

  let submission: BundleSubmission;
  try {
    submission = await submitter.submit([tx], decision.tipLamports, currentSlot);
    console.log(`      ✓ Submitted — uuid: ${submission.uuid}`);
  } catch (err) {
    console.error("      ✗ Submission failed:", err);
    cleanup(stream, tracker, submitter);
    process.exit(1);
  }

  tracker.track(sig, submission.submittedSlot);

  // --- Wait for finality ---
  console.log("\n  Waiting for finality...\n");
  console.log("  Slot log:");

  const lifecycle = await new Promise<TxLifecycle>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Finality timeout")), FINALITY_TIMEOUT_MS);

    function finish(tx: TxLifecycle) {
      clearTimeout(timeout);
      resolve(tx);
    }

    tracker.on("processed", (tx: TxLifecycle) => {
      if (tx.signature !== sig) return;
      console.log(`    processed  slot ${tx.processedSlot}   ${new Date(tx.processedAt!).toISOString()}`);
    });

    tracker.on("confirmed", (tx: TxLifecycle) => {
      if (tx.signature !== sig) return;
      console.log(`    confirmed  slot ${tx.confirmedSlot}   ${new Date(tx.confirmedAt!).toISOString()}`);
    });

    tracker.on("finalized", (tx: TxLifecycle) => {
      if (tx.signature !== sig) return;
      console.log(`    finalized  slot ${tx.finalizedSlot}   ${new Date(tx.finalizedAt!).toISOString()}`);
      finish(tx);
    });

    tracker.on("dropped", (tx: TxLifecycle) => {
      if (tx.signature !== sig) return;
      finish(tx);
    });

    tracker.on("failed", (tx: TxLifecycle) => {
      if (tx.signature !== sig) return;
      finish(tx);
    });
  }).catch((err: Error) => {
    console.error("\n  ✗", err.message);
    return tracker.getAll().find((t) => t.signature === sig)!;
  });

  // --- Summary ---
  console.log("\n" + "━".repeat(60));
  console.log("  Lifecycle Summary");
  console.log("━".repeat(60));
  console.log(`  Signature  : ${lifecycle.signature}`);
  console.log(`  Final state: ${lifecycle.status.toUpperCase()}`);
  console.log(`  Submitted  : slot ${lifecycle.submittedSlot}   ${new Date(lifecycle.submittedAt).toISOString()}`);

  if (lifecycle.processedSlot != null) {
    console.log(`  Processed  : slot ${lifecycle.processedSlot}   ${new Date(lifecycle.processedAt!).toISOString()}`);
  }
  if (lifecycle.confirmedSlot != null) {
    const delta = lifecycle.confirmedAt! - lifecycle.processedAt!;
    console.log(`  Confirmed  : slot ${lifecycle.confirmedSlot}   ${new Date(lifecycle.confirmedAt!).toISOString()}   (processed→confirmed: ${delta}ms)`);
  }
  if (lifecycle.finalizedSlot != null) {
    console.log(`  Finalized  : slot ${lifecycle.finalizedSlot}   ${new Date(lifecycle.finalizedAt!).toISOString()}`);
  }

  console.log(`  Tip used   : ${decision.tipLamports.toLocaleString()} lamports`);
  console.log(`  Agent note : "${decision.reasoning}"`);
  console.log(`\n  Explorer   : https://solscan.io/tx/${lifecycle.signature}`);
  console.log("━".repeat(60));

  cleanup(stream, tracker, submitter);
}

function cleanup(stream: SlotStream, tracker: LifecycleTracker, submitter: BundleSubmitter) {
  stream.stop();
  tracker.stop();
  submitter.destroy();
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
