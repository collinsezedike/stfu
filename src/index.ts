/**
 * STFU — continuous monitoring mode (pnpm dev)
 *
 * Connects to the Geyser stream, tracks any bundles submitted externally, and
 * keeps a live slot display. The AI tip agent is initialised and available but
 * submissions are not automated here — use `pnpm demo` for end-to-end bundle
 * submission with the full retry loop.
 */

import "dotenv/config";
import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { SlotStream, SlotUpdate } from "./stream/index.js";
import { LifecycleTracker, TxLifecycle } from "./tracker/index.js";
import { BundleSubmitter, BundleSubmission, BundleResult } from "./bundle/index.js";
import { TipAgent } from "./agent/index.js";

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
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

  const stream = new SlotStream(endpoint, token);
  const tracker = new LifecycleTracker(connection);
  const submitter = new BundleSubmitter(connection, payer, blockEngineUrl);

  // TipAgent is ready for on-demand use; not auto-triggered in monitoring mode
  const _agent = new TipAgent(connection, anthropicKey, tipFloor);

  // --- Slot stream ---
  stream.on("connected", () => console.log("[main] Geyser stream connected"));

  stream.on("slot", (update: SlotUpdate) => {
    if (update.status === "processed") {
      tracker.updateSlot(update.slot);
      process.stdout.write(`\r[slot] ${update.slot}   `);
    } else {
      console.log(`\n[slot] ${update.slot} → ${update.status}`);
    }
  });

  stream.on("reconnecting", (attempt: number) =>
    console.warn(`\n[main] Reconnecting... attempt ${attempt}`)
  );
  stream.on("error", (err: Error) =>
    console.error("\n[main] Stream error:", err.message)
  );

  // --- Bundle results ---
  submitter.on("submitted", (sub: BundleSubmission) => {
    for (const sig of sub.signatures) {
      tracker.track(sig, sub.submittedSlot);
    }
  });

  submitter.on("accepted", (result: BundleResult) => {
    console.log(`\n[main] Bundle ACCEPTED: ${result.uuid}`);
  });

  submitter.on("rejected", (result: BundleResult) => {
    console.warn(`\n[main] Bundle REJECTED: ${result.uuid} — ${result.reason}`);
  });

  // --- Lifecycle events ---
  tracker.on("confirmed", (tx: TxLifecycle) => {
    const delta = tx.confirmedAt! - tx.processedAt!;
    console.log(`\n[main] ${tx.signature.slice(0, 8)}… confirmed | processed→confirmed: ${delta}ms`);
  });

  tracker.on("finalized", (tx: TxLifecycle) => {
    console.log(`\n[main] ${tx.signature.slice(0, 8)}… finalized at slot ${tx.finalizedSlot}`);
  });

  tracker.on("dropped", (tx: TxLifecycle) => {
    console.warn(
      `\n[main] ${tx.signature.slice(0, 8)}… DROPPED ` +
        `(no confirmation within 150 slots of ${tx.submittedSlot})`
    );
  });

  tracker.on("failed", (tx: TxLifecycle) => {
    console.error(
      `\n[main] ${tx.signature.slice(0, 8)}… FAILED [${tx.failureType ?? "unknown"}]: ${tx.error}`
    );
  });

  tracker.start();

  function shutdown() {
    console.log("\n[main] Shutting down...");
    stream.stop();
    tracker.stop();
    submitter.destroy();
    process.exit(0);
  }

  // Handle both interactive (SIGINT) and process-manager (SIGTERM) stops
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await stream.start();
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
