import "dotenv/config";
import { SlotStream, SlotUpdate } from "./stream/index.js";

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

async function main() {
  const endpoint = requireEnv("GEYSER_ENDPOINT");
  const token = process.env["GEYSER_TOKEN"] ?? "";

  const stream = new SlotStream(endpoint, token);

  stream.on("connected", () => {
    console.log("[main] Geyser stream connected");
  });

  stream.on("slot", (update: SlotUpdate) => {
    if (update.status === "processed") {
      process.stdout.write(`\r[slot] ${update.slot} (${update.status})   `);
    } else {
      console.log(`[slot] ${update.slot} → ${update.status}`);
    }
  });

  stream.on("reconnecting", (attempt: number) => {
    console.warn(`[main] Reconnecting... attempt ${attempt}`);
  });

  stream.on("error", (err: Error) => {
    console.error("[main] Stream error:", err.message);
  });

  process.on("SIGINT", () => {
    console.log("\n[main] Shutting down...");
    stream.stop();
    process.exit(0);
  });

  await stream.start();
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
