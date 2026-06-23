/**
 * STFU end-to-end demo
 *
 * Submits a 1-lamport self-transfer as a Jito bundle and prints the full
 * lifecycle log (slot numbers + timestamps) as it advances to finality.
 * Retries up to MAX_RETRIES times on failure, refreshing the blockhash and
 * re-running the tip agent on each attempt.
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
import { writeLifecycleLog, getLogPath } from "./logger.js";
import { LifecycleTracker, TxLifecycle } from "./tracker/index.js";
import { BundleSubmitter, BundleSubmission, BundleResult } from "./bundle/index.js";
import { TipAgent, TipDecision } from "./agent/index.js";

const MAX_RETRIES = 3;
const FINALITY_TIMEOUT_MS = 120_000;
const STREAM_CONNECT_TIMEOUT_MS = 15_000;

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

async function waitForFirstSlot(stream: SlotStream): Promise<number> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for first slot — check GEYSER_ENDPOINT and GEYSER_TOKEN")),
      STREAM_CONNECT_TIMEOUT_MS
    );
    const handler = (update: SlotUpdate) => {
      if (update.status === "processed") {
        clearTimeout(timeout);
        stream.off("slot", handler);
        resolve(update.slot);
      }
    };
    stream.on("slot", handler);
  });
}

/**
 * Waits for the tracker to emit a terminal event for `sig`.
 * Cleans up its own listeners regardless of how it resolves (timeout or event).
 */
function waitForOutcome(
  tracker: LifecycleTracker,
  sig: string
): Promise<TxLifecycle> {
  return new Promise<TxLifecycle>((resolve) => {
    let settled = false;

    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      // Return whatever state we have — caller decides whether to retry
      const lc = tracker.getAll().find((t) => t.signature === sig);
      resolve(
        lc ?? ({
          signature: sig,
          status: "dropped",
          submittedAt: Date.now(),
          submittedSlot: 0,
        } as TxLifecycle)
      );
    }, FINALITY_TIMEOUT_MS);

    function finish(tx: TxLifecycle) {
      if (tx.signature !== sig || settled) return;
      settled = true;
      cleanup();
      resolve(tx);
    }

    function cleanup() {
      clearTimeout(timeoutId);
      tracker.off("finalized", finish);
      tracker.off("failed", finish);
      tracker.off("dropped", finish);
    }

    tracker.on("finalized", finish);
    tracker.on("failed", finish);
    tracker.on("dropped", finish);
  });
}

/**
 * Fetch fresh context, build a signed transaction, and submit the bundle.
 * Returns everything needed to track the outcome and write the log.
 */
async function buildAndSubmit(
  connection: Connection,
  payer: Keypair,
  submitter: BundleSubmitter,
  agent: TipAgent,
  currentSlot: number,
  attempt: number
): Promise<{ submission: BundleSubmission; sig: string; decision: TipDecision }> {
  const leader = await submitter.getNextLeader();
  console.log(
    `\n  [attempt ${attempt}/${MAX_RETRIES}] Leader: slot ${leader.nextLeaderSlot} ` +
      `(${leader.nextLeaderSlot - currentSlot} slots away)`
  );

  const context = await agent.gatherContext(currentSlot, leader.nextLeaderSlot);
  const decision = await agent.decide(context);
  console.log(`    Tip       : ${decision.tipLamports.toLocaleString()} lamports`);
  console.log(`    Confidence: ${decision.confidence}`);
  console.log(`    Reasoning : "${decision.reasoning}"`);

  // Fetch blockhash once — used for both the user tx and the tip tx so they
  // share the same expiry window (fixes the two-blockhash timing gap).
  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  const ix = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: payer.publicKey,
    lamports: 1,
  });
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([payer]);

  const sig = bs58.encode(tx.signatures[0]!);
  console.log(`    Signature : ${sig}`);
  console.log(`    Blockhash : ${blockhash}`);

  const submission = await submitter.submit([tx], decision.tipLamports, currentSlot, blockhash);
  console.log(`    UUID      : ${submission.uuid}`);

  return { submission, sig, decision };
}

async function main() {
  const endpoint = requireEnv("GEYSER_ENDPOINT");
  const token = process.env["GEYSER_TOKEN"] ?? "";
  const rpcUrl = process.env["RPC_URL"] ?? "https://api.mainnet-beta.solana.com";
  const blockEngineUrl = process.env["JITO_BLOCK_ENGINE_URL"] ?? "mainnet.block-engine.jito.wtf";
  const privateKey = requireEnv("WALLET_PRIVATE_KEY");
  const anthropicKey = requireEnv("ANTHROPIC_API_KEY");
  const tipFloor = parseInt(process.env["TIP_FLOOR_LAMPORTS"] ?? "1000000", 10);

  const payer = Keypair.fromSecretKey(bs58.decode(privateKey));
  const connection = new Connection(rpcUrl, "confirmed");

  console.log("━".repeat(60));
  console.log("  STFU — Smart Transaction Forwarding Unit");
  console.log("  End-to-End Demo");
  console.log("━".repeat(60));
  console.log(`  Wallet : ${payer.publicKey.toBase58()}`);
  console.log(`  RPC    : ${rpcUrl}`);
  console.log(`  Engine : ${blockEngineUrl}`);
  console.log("━".repeat(60));

  const stream = new SlotStream(endpoint, token);
  const tracker = new LifecycleTracker(connection);
  const submitter = new BundleSubmitter(connection, payer, blockEngineUrl);
  const agent = new TipAgent(connection, anthropicKey, tipFloor);

  stream.on("error", (err: Error) => console.error("[stream]", err.message));
  stream.on("reconnecting", (n: number) => console.warn(`[stream] Reconnecting (attempt ${n})`));

  let currentSlot = 0;
  stream.on("slot", (update: SlotUpdate) => {
    if (update.status === "processed") {
      currentSlot = update.slot;
      tracker.updateSlot(update.slot);
    }
  });

  submitter.on("accepted", (result: BundleResult) => {
    console.log(`\n  ✓ Bundle ACCEPTED — uuid: ${result.uuid}`);
  });
  submitter.on("rejected", (result: BundleResult) => {
    console.warn(`\n  ✗ Bundle REJECTED — ${result.reason}`);
  });

  tracker.start();
  stream.start();

  console.log("\n[1/3] Connecting to Geyser stream...");
  currentSlot = await waitForFirstSlot(stream);
  console.log(`      ✓ Live at slot ${currentSlot}`);

  // --- Retry loop ---
  let lifecycle: TxLifecycle | undefined;
  let finalDecision: TipDecision | undefined;

  console.log("\n[2/3] Submitting bundle...");

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let submission: BundleSubmission;
    let sig: string;
    let decision: TipDecision;

    try {
      ({ submission, sig, decision } = await buildAndSubmit(
        connection, payer, submitter, agent, currentSlot, attempt
      ));
      finalDecision = decision;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_RETRIES) {
        console.warn(`\n  ✗ Attempt ${attempt} submission error: ${msg} — retrying...`);
        continue;
      }
      console.error(`\n  ✗ All ${MAX_RETRIES} attempts failed. Last error: ${msg}`);
      cleanup(stream, tracker, submitter);
      process.exit(1);
    }

    const lc = tracker.track(sig, submission.submittedSlot);
    if (attempt > 1) lc.retryCount = attempt - 1;

    console.log(`\n  Waiting for finality (attempt ${attempt})...`);

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
    });

    const outcome = await waitForOutcome(tracker, sig);

    // Terminal success or unrecoverable failure
    if (outcome.status === "finalized" || outcome.status === "failed") {
      lifecycle = outcome;
      break;
    }

    // Recoverable: dropped (low tip / leader skip) or timeout
    if (attempt < MAX_RETRIES) {
      console.warn(
        `\n  ✗ Attempt ${attempt} ${outcome.status} — ` +
          `refreshing blockhash and tip, retrying...`
      );
      lifecycle = outcome;
      continue;
    }

    lifecycle = outcome;
  }

  if (!lifecycle) {
    console.error("No lifecycle recorded");
    cleanup(stream, tracker, submitter);
    process.exit(1);
  }

  // --- Summary ---
  console.log("\n[3/3] Complete");
  console.log("\n" + "━".repeat(60));
  console.log("  Lifecycle Summary");
  console.log("━".repeat(60));
  console.log(`  Signature   : ${lifecycle.signature}`);
  console.log(`  Final state : ${lifecycle.status.toUpperCase()}`);
  if (lifecycle.retryCount) {
    console.log(`  Retries     : ${lifecycle.retryCount}`);
  }
  console.log(`  Submitted   : slot ${lifecycle.submittedSlot}   ${new Date(lifecycle.submittedAt).toISOString()}`);

  if (lifecycle.processedSlot != null) {
    console.log(`  Processed   : slot ${lifecycle.processedSlot}   ${new Date(lifecycle.processedAt!).toISOString()}`);
  }
  if (lifecycle.confirmedSlot != null) {
    const delta = lifecycle.confirmedAt! - lifecycle.processedAt!;
    console.log(
      `  Confirmed   : slot ${lifecycle.confirmedSlot}   ${new Date(lifecycle.confirmedAt!).toISOString()}` +
        `   (processed→confirmed: ${delta}ms)`
    );
  }
  if (lifecycle.finalizedSlot != null) {
    console.log(`  Finalized   : slot ${lifecycle.finalizedSlot}   ${new Date(lifecycle.finalizedAt!).toISOString()}`);
  }
  if (lifecycle.error) {
    console.log(`  Error       : ${lifecycle.error}`);
    console.log(`  Failure type: ${lifecycle.failureType ?? "unknown"}`);
  }

  if (finalDecision) {
    console.log(`  Tip used    : ${finalDecision.tipLamports.toLocaleString()} lamports`);
    console.log(`  Agent note  : "${finalDecision.reasoning}"`);
  }
  console.log(`\n  Explorer    : https://solscan.io/tx/${lifecycle.signature}`);
  console.log("━".repeat(60));

  writeLifecycleLog({
    ...lifecycle,
    tipLamports: finalDecision?.tipLamports,
    agentReasoning: finalDecision?.reasoning,
  });
  console.log(`  Log file    : ${getLogPath()}`);

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
