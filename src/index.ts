import "dotenv/config";
import { Connection } from "@solana/web3.js";
import { SlotStream, SlotUpdate } from "./stream/index.js";
import { LifecycleTracker } from "./tracker/index.js";

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

async function main() {
  const endpoint = requireEnv("GEYSER_ENDPOINT");
  const token = process.env["GEYSER_TOKEN"] ?? "";
  const rpcUrl = process.env["RPC_URL"] ?? "https://api.mainnet-beta.solana.com";

  const connection = new Connection(rpcUrl, "confirmed");
  const stream = new SlotStream(endpoint, token);
  const tracker = new LifecycleTracker(connection);

  stream.on("connected", () => console.log("[main] Geyser stream connected"));

  stream.on("slot", (update: SlotUpdate) => {
    if (update.status === "processed") {
      tracker.updateSlot(update.slot);
      process.stdout.write(`\r[slot] ${update.slot}   `);
    } else {
      console.log(`\n[slot] ${update.slot} → ${update.status}`);
    }
  });

  stream.on("reconnecting", (attempt: number) => {
    console.warn(`[main] Reconnecting... attempt ${attempt}`);
  });

  stream.on("error", (err: Error) => {
    console.error("[main] Stream error:", err.message);
  });

  tracker.start();

  process.on("SIGINT", () => {
    console.log("\n[main] Shutting down...");
    stream.stop();
    tracker.stop();
    process.exit(0);
  });

  await stream.start();
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
