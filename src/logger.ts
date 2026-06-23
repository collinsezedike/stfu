import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { TxLifecycle } from "./tracker/index.js";

const LOG_DIR = "logs";

// Fixed at startup so all records from one run share a filename
const logFile = join(LOG_DIR, `lifecycle-${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`);

export function writeLifecycleLog(
  entry: TxLifecycle & { tipLamports?: number; agentReasoning?: string }
): void {
  // Lazy creation: only create the directory when we actually write a record,
  // so importing this module in tests or dry-run contexts has no side effects.
  mkdirSync(LOG_DIR, { recursive: true });

  const record = {
    ...entry,
    _loggedAt: new Date().toISOString(),
  };
  appendFileSync(logFile, JSON.stringify(record) + "\n", "utf8");
  console.log(`[logger] Wrote lifecycle record → ${logFile}`);
}

export function getLogPath(): string {
  return logFile;
}
