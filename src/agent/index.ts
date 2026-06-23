import Anthropic from "@anthropic-ai/sdk";
import { Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";

const AGENT_TIMEOUT_MS = 4_000;

export interface NetworkConditions {
  medianPriorityFee: number;  // micro-lamports per compute unit
  p75PriorityFee: number;     // micro-lamports per compute unit
  sampleSlots: number;        // number of recent slots sampled
}

export interface TipContext {
  currentSlot: number;
  nextLeaderSlot: number;
  slotsUntilLeader: number;
  networkCongestion: "low" | "medium" | "high";
  conditions: NetworkConditions;
}

export interface TipDecision {
  tipLamports: number;
  reasoning: string;
  confidence: "low" | "medium" | "high";
}

function isValidTipDecision(obj: unknown): obj is TipDecision {
  if (!obj || typeof obj !== "object") return false;
  const d = obj as Record<string, unknown>;
  return (
    typeof d.tipLamports === "number" &&
    !isNaN(d.tipLamports) &&
    d.tipLamports > 0 &&
    typeof d.reasoning === "string" &&
    d.reasoning.length > 0 &&
    (d.confidence === "low" || d.confidence === "medium" || d.confidence === "high")
  );
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

    // getRecentPrioritizationFees returns per-slot min fees (micro-lamports / CU)
    // over the last ~150 slots. This reflects actual fee pressure on the network,
    // unlike tip account balances which are affected by Jito's sweep schedule.
    const recentFees = await this.connection.getRecentPrioritizationFees();
    const feeSamples = recentFees
      .map((f) => f.prioritizationFee)
      .sort((a, b) => a - b);

    const sampleSlots = feeSamples.length;
    const mid = Math.floor(sampleSlots / 2);
    const medianPriorityFee = feeSamples[mid] ?? 0;
    const p75PriorityFee = feeSamples[Math.floor(sampleSlots * 0.75)] ?? 0;

    const networkCongestion: TipContext["networkCongestion"] =
      p75PriorityFee > 10_000
        ? "high"
        : p75PriorityFee > 1_000
        ? "medium"
        : "low";

    return {
      currentSlot,
      nextLeaderSlot,
      slotsUntilLeader,
      networkCongestion,
      conditions: { medianPriorityFee, p75PriorityFee, sampleSlots },
    };
  }

  async decide(context: TipContext): Promise<TipDecision> {
    const floorSol = (this.floorLamports / LAMPORTS_PER_SOL).toFixed(6);

    const systemPrompt =
      `You are the tip-setting engine for STFU (Smart Transaction Forwarding Unit), ` +
      `a Solana MEV infrastructure stack that submits transaction bundles via Jito. ` +
      `Your sole task is to decide the optimal tip in lamports to attach to the next bundle. ` +
      `Respond with a valid JSON object only — no markdown fences, no text outside the JSON.`;

    const userPrompt =
      `## Network State\n` +
      `- Current slot: ${context.currentSlot}\n` +
      `- Next Jito leader slot: ${context.nextLeaderSlot} ` +
        `(${context.slotsUntilLeader} slots away, ~${(context.slotsUntilLeader * 0.4).toFixed(1)}s)\n` +
      `- Network congestion: ${context.networkCongestion}\n` +
      `- Recent priority fees (micro-lamports/CU, last ${context.conditions.sampleSlots} slots):\n` +
      `  • Median : ${context.conditions.medianPriorityFee}\n` +
      `  • P75    : ${context.conditions.p75PriorityFee}\n\n` +
      `## Tip Floor\n` +
      `Minimum tip: ${this.floorLamports} lamports (${floorSol} SOL)\n\n` +
      `## Decision Rules\n` +
      `1. High congestion (P75 > 10 000 µL/CU) and leader < 5 slots away: ` +
        `tip 3–5× floor to compete for inclusion.\n` +
      `2. Medium congestion (P75 > 1 000 µL/CU): tip 1.5–2× floor.\n` +
      `3. Low congestion and leader > 10 slots away: tip at floor — no urgency.\n` +
      `4. Never exceed 0.01 SOL (10 000 000 lamports) unless congestion is extreme.\n\n` +
      `Respond with:\n` +
      `{"tipLamports": <integer>, "reasoning": "<one sentence>", "confidence": "low"|"medium"|"high"}`;

    const apiCall = this.client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Agent decision timed out after ${AGENT_TIMEOUT_MS}ms`)),
        AGENT_TIMEOUT_MS
      )
    );

    let text: string;
    try {
      const message = await Promise.race([apiCall, timeoutPromise]);
      text = message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
    } catch (err) {
      console.warn("[agent] Request failed, using floor tip:", err instanceof Error ? err.message : err);
      return this.fallback("Request failed");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.warn("[agent] Failed to parse response, using floor tip:", text);
      return this.fallback("Parse failure");
    }

    if (!isValidTipDecision(parsed)) {
      console.warn("[agent] Response failed validation, using floor tip:", parsed);
      return this.fallback("Validation failure");
    }

    const decision: TipDecision = {
      ...parsed,
      tipLamports: Math.max(parsed.tipLamports, this.floorLamports),
    };

    console.log(
      `[agent] Tip decision: ${decision.tipLamports} lamports | ` +
        `confidence: ${decision.confidence} | "${decision.reasoning}"`
    );

    return decision;
  }

  private fallback(reason: string): TipDecision {
    return {
      tipLamports: this.floorLamports,
      reasoning: `${reason} — defaulting to floor tip`,
      confidence: "low",
    };
  }
}
