import Anthropic from "@anthropic-ai/sdk";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";

// The 8 Jito tip accounts (mainnet)
const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt13nhwcXa",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
].map((a) => new PublicKey(a));

export interface TipContext {
  recentTips: RecentTip[];
  nextLeaderSlot: number;
  slotsUntilLeader: number;
  currentSlot: number;
  networkCongestion: "low" | "medium" | "high";
}

export interface RecentTip {
  account: string;
  balanceSol: number;
}

export interface TipDecision {
  tipLamports: number;
  reasoning: string;
  confidence: "low" | "medium" | "high";
}

export class TipAgent {
  private readonly client: Anthropic;
  private readonly floorLamports: number;

  constructor(
    private readonly connection: Connection,
    apiKey: string,
    floorLamports = 1_000_000
  ) {
    this.client = new Anthropic({ apiKey });
    this.floorLamports = floorLamports;
  }

  async gatherContext(
    currentSlot: number,
    nextLeaderSlot: number
  ): Promise<TipContext> {
    const slotsUntilLeader = nextLeaderSlot - currentSlot;

    const balances = await Promise.allSettled(
      JITO_TIP_ACCOUNTS.slice(0, 4).map(async (pk) => {
        const bal = await this.connection.getBalance(pk, "confirmed");
        return { account: pk.toBase58().slice(0, 8) + "…", balanceSol: bal / LAMPORTS_PER_SOL };
      })
    );

    const recentTips: RecentTip[] = balances
      .filter((r): r is PromiseFulfilledResult<RecentTip> => r.status === "fulfilled")
      .map((r) => r.value);

    const avgBalance = recentTips.reduce((sum, t) => sum + t.balanceSol, 0) / (recentTips.length || 1);
    const networkCongestion: TipContext["networkCongestion"] =
      avgBalance > 10 ? "high" : avgBalance > 2 ? "medium" : "low";

    return { recentTips, nextLeaderSlot, slotsUntilLeader, currentSlot, networkCongestion };
  }

  async decide(context: TipContext): Promise<TipDecision> {
    const prompt = `You are the tip-setting engine for STFU (Smart Transaction Forwarding Unit), a Solana MEV infrastructure stack that submits transaction bundles via Jito.

Your task: decide the optimal tip in lamports to attach to the next Jito bundle.

## Current Network Context
- Current slot: ${context.currentSlot}
- Next Jito leader slot: ${context.nextLeaderSlot} (${context.slotsUntilLeader} slots away, ~${(context.slotsUntilLeader * 0.4).toFixed(1)}s)
- Network congestion estimate: ${context.networkCongestion}
- Recent Jito tip account balances (proxy for recent tip activity):
${context.recentTips.map((t) => `  • ${t.account}: ${t.balanceSol.toFixed(4)} SOL`).join("\n")}

## Tip Floor
Minimum tip: ${this.floorLamports} lamports (${(this.floorLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL)

## Decision Rules
1. If congestion is high and leader is < 5 slots away, tip aggressively (3–5× floor) to ensure inclusion.
2. If congestion is medium, tip 1.5–2× floor.
3. If congestion is low and leader is > 10 slots away, tip at floor — no urgency.
4. Never tip more than 0.01 SOL (10,000,000 lamports) unless congestion is extreme.

Respond with a JSON object only — no markdown, no explanation outside the JSON:
{
  "tipLamports": <integer>,
  "reasoning": "<one concise sentence explaining your decision>",
  "confidence": "low" | "medium" | "high"
}`;

    const message = await this.client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      messages: [{ role: "user", content: prompt }],
    });

    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    let decision: TipDecision;
    try {
      decision = JSON.parse(text) as TipDecision;
    } catch {
      console.warn("[agent] Failed to parse response, using floor tip:", text);
      decision = {
        tipLamports: this.floorLamports,
        reasoning: "Parse failure — defaulting to floor tip",
        confidence: "low",
      };
    }

    // Enforce floor
    decision.tipLamports = Math.max(decision.tipLamports, this.floorLamports);

    console.log(
      `[agent] Tip decision: ${decision.tipLamports} lamports | ` +
      `confidence: ${decision.confidence} | "${decision.reasoning}"`
    );

    return decision;
  }
}
