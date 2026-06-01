import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { TxLifecycle } from "./tracker/index.js";

const LOG_DIR = "logs";

mkdirSync(LOG_DIR, { recursive: true });

const logFile = join(LOG_DIR, `lifecycle-${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`);

export function writeLifecycleLog(entry: TxLifecycle & { tipLamports?: number; agentReasoning?: string }): void {
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
