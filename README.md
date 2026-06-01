# STFU — Smart Transaction Forwarding Unit

A production-grade Solana transaction infrastructure stack. STFU streams live slot data from a Geyser node, submits transaction bundles through Jito, tracks every bundle from submission to finality, and uses an AI agent to decide optimal tip amounts based on real-time network conditions.

---

## Architecture

```
 ┌─────────────────────────────────────────────────────────────────┐
 │                        STFU Stack                               │
 │                                                                 │
 │  ┌──────────────┐   slot updates   ┌──────────────────────┐    │
 │  │ Geyser Node  │ ───────────────► │   SlotStream         │    │
 │  │ (Yellowstone │                  │   • reconnect/backoff│    │
 │  │   gRPC)      │                  │   • processed events │    │
 │  └──────────────┘                  └──────────┬───────────┘    │
 │                                               │ currentSlot    │
 │                                    ┌──────────▼───────────┐    │
 │  ┌──────────────┐   tip context    │   TipAgent (Claude)  │    │
 │  │  Jito Block  │ ◄──────────────  │   • tip acct balances│    │
 │  │  Engine      │                  │   • congestion signal│    │
 │  │              │   sendBundle     │   • structured reason│    │
 │  │              │ ◄──────────────  └──────────────────────┘    │
 │  └──────┬───────┘                                              │
 │         │ BundleResult             ┌──────────────────────┐    │
 │         └────────────────────────► │  BundleSubmitter     │    │
 │                                    │  • tip tx injection  │    │
 │                                    │  • result streaming  │    │
 │                                    └──────────┬───────────┘    │
 │                                               │ signatures     │
 │  ┌──────────────┐  getSignatureStatuses       │                │
 │  │  Solana RPC  │ ◄────────────────────────── │                │
 │  └──────┬───────┘                  ┌──────────▼───────────┐    │
 │         │ confirmationStatus       │  LifecycleTracker    │    │
 │         └────────────────────────► │  submitted           │    │
 │                                    │  → processed         │    │
 │                                    │  → confirmed         │    │
 │                                    │  → finalized/dropped │    │
 │                                    └──────────────────────┘    │
 └─────────────────────────────────────────────────────────────────┘
```

**Data flow:**
1. `SlotStream` opens a Yellowstone gRPC subscription and emits typed slot events
2. Each processed slot feeds `currentSlot` into the `LifecycleTracker` (drop detection) and the `TipAgent` (timing context)
3. Before submitting a bundle, `TipAgent` samples Jito tip account balances, estimates congestion, and calls Claude Haiku for a reasoned tip decision
4. `BundleSubmitter` appends a tip transaction and calls `sendBundle` on the Jito block engine
5. `LifecycleTracker` polls `getSignatureStatuses` every second, advancing each transaction through its state machine and logging real slot numbers + timestamps at every transition

---

## Modules

### `src/stream/` — Yellowstone gRPC Slot Monitor

Maintains a persistent gRPC subscription to a Geyser node. Emits `SlotUpdate` events for every `processed`, `confirmed`, and `finalized` slot.

**Reconnection:** Uses exponential backoff (1s → 30s cap). On each reconnect, the gRPC client is fully recreated — reusing a stuck channel is a common source of silent failures.

```ts
const stream = new SlotStream(endpoint, token);
stream.on("slot", (update: SlotUpdate) => { /* slot, status, timestamp */ });
stream.on("reconnecting", (attempt) => { /* ... */ });
await stream.start();
```

### `src/tracker/` — Transaction Lifecycle Tracker

State machine that tracks every submitted signature through its full confirmation lifecycle. Polls `getSignatureStatuses` every 1 second against the Solana RPC.

States: `submitted → processed → confirmed → finalized` (or `failed` / `dropped`)

Records a real slot number and Unix timestamp at each transition. These are the values you cross-reference on [Solscan](https://solscan.io) or [SolanaFM](https://solana.fm).

```ts
const tracker = new LifecycleTracker(connection);
tracker.track(signature, submittedSlot);
tracker.on("confirmed", (tx) => { /* tx.confirmedSlot, tx.confirmedAt */ });
tracker.on("finalized", (tx) => { /* tx.finalizedSlot */ });
tracker.on("dropped", (tx)  => { /* no confirmation after 150 slots */ });
```

### `src/bundle/` — Jito Bundle Submitter

Builds and submits versioned transaction bundles to the Jito block engine. Automatically:
- Fetches live tip accounts from the block engine
- Selects one at random (distributes tip load)
- Appends a tip transaction using a `confirmed` blockhash
- Subscribes to the block engine's result stream for accepted/rejected callbacks

```ts
const submitter = new BundleSubmitter(connection, payer, blockEngineUrl);
const submission = await submitter.submit(transactions, tipLamports, currentSlot);
submitter.on("accepted", (result) => { /* result.uuid */ });
submitter.on("rejected", (result) => { /* result.reason */ });
```

### `src/agent/` — AI Tip Agent

The only component that makes autonomous decisions. Before each bundle submission, the agent:

1. Samples the balances of 4 Jito tip accounts (a proxy for recent tip volume)
2. Calculates slots until the next Jito leader window
3. Derives a congestion signal (`low` / `medium` / `high`)
4. Calls **Claude Haiku** (`claude-haiku-4-5`) with a structured prompt containing all of the above — this is the AI agent layer, not a heuristic wrapper
5. Parses the model's JSON response into a `TipDecision` with explicit reasoning

The model's decision rationale is logged on every submission. The tip floor is enforced after parsing to prevent the model from going below the configured minimum.

```ts
const agent = new TipAgent(connection, anthropicApiKey, tipFloorLamports);
const context = await agent.gatherContext(currentSlot, nextLeaderSlot);
const decision = await agent.decide(context);
// decision.tipLamports, decision.reasoning, decision.confidence
```

---

## Setup

```bash
pnpm install
cp .env.example .env
# Fill in .env — see steps below
pnpm demo   # end-to-end test run (~0.002 SOL)
pnpm dev    # run the full stack continuously
```

### Step 1 — Geyser endpoint

STFU requires a [Yellowstone gRPC](https://github.com/rpcpool/yellowstone-grpc) endpoint. The public Solana RPC does not provide one. Auth is required by every hosted provider.

| Provider | Notes |
|---|---|
| [Helius](https://helius.dev) | Business plan and above include gRPC |
| [Triton One](https://triton.one) | Dedicated Yellowstone nodes |
| [QuickNode](https://quicknode.com) | Yellowstone available as a marketplace add-on |

```
GEYSER_ENDPOINT=https://your-region.helius-rpc.com/?api-key=YOUR_KEY
GEYSER_TOKEN=YOUR_KEY
RPC_URL=https://your-region.helius-rpc.com/?api-key=YOUR_KEY
```

### Step 2 — Wallet

You need a mainnet wallet funded with at least **0.003 SOL** (tip + transaction fee + buffer). Generate one using the project's own runtime:

```bash
node --input-type=module << 'EOF'
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
const kp = Keypair.generate();
console.log("Public key :", kp.publicKey.toBase58());
console.log("Private key:", bs58.encode(kp.secretKey));
EOF
```

Fund the public key from an exchange or another wallet, then add to `.env`:

```
WALLET_PRIVATE_KEY=<base58 private key>
```

### Step 3 — Remaining config

The Jito block engine URL is fixed for mainnet — no account or registration needed. The Anthropic API key is used exclusively by the AI tip agent (`src/agent/`) to reason about network conditions.

```
JITO_BLOCK_ENGINE_URL=mainnet.block-engine.jito.wtf
ANTHROPIC_API_KEY=<from console.anthropic.com>
TIP_FLOOR_LAMPORTS=1000000
```

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GEYSER_ENDPOINT` | ✓ | Yellowstone gRPC endpoint |
| `GEYSER_TOKEN` | ✓ | Auth token — required by all hosted Geyser providers |
| `RPC_URL` | — | Solana RPC URL (defaults to mainnet public) |
| `JITO_BLOCK_ENGINE_URL` | — | Block engine host (default: `mainnet.block-engine.jito.wtf`) |
| `WALLET_PRIVATE_KEY` | ✓ | Base58-encoded private key, min 0.003 SOL balance |
| `ANTHROPIC_API_KEY` | ✓ | Used by the AI tip agent to call Claude Haiku |
| `TIP_FLOOR_LAMPORTS` | — | Minimum tip in lamports (default: 1,000,000 = 0.001 SOL) |

---

## Lifecycle Logs

Every completed bundle run (successful or failed) is written as a JSON record to `logs/lifecycle-<timestamp>.ndjson`. Each line is one transaction:

```json
{
  "signature": "3xKf...",
  "status": "finalized",
  "submittedAt": 1748736000000,
  "submittedSlot": 327841092,
  "processedAt": 1748736001234,
  "processedSlot": 327841106,
  "confirmedAt": 1748736001891,
  "confirmedSlot": 327841108,
  "finalizedAt": 1748736014000,
  "finalizedSlot": 327841140,
  "tipLamports": 1500000,
  "agentReasoning": "Medium congestion with leader 13 slots away — 1.5× floor is sufficient"
}
```

Slot numbers in these records are verifiable on [Solscan](https://solscan.io) and [SolanaFM](https://solana.fm). Cross-reference `processedSlot` against the block timestamp on-chain to confirm the log is real.

**Triggering failure cases** for the log:

| Failure | How to produce |
|---|---|
| `dropped` | Set `TIP_FLOOR_LAMPORTS=1` to submit a below-floor tip — Jito drops bundles with insufficient tips silently after ~150 slots |
| `rejected` | Submit a bundle with a stale blockhash by artificially delaying before `sendBundle` — the block engine returns an immediate rejection |

---

## Infrastructure Q&A

### What does the `processed_at → confirmed_at` delta tell you?

It measures how long it took for the transaction's block to earn supermajority confirmation — i.e., for validators holding more than two-thirds of total stake to vote on that block.

A short delta (under 1 second) is normal on a healthy network. A long delta means validators are slow to vote, which can indicate heavy network load, a fork being resolved, or stake-weighted vote propagation delays. Watching this metric across many transactions gives you a real-time read on validator health that you can't get from slot times alone.

### Why do we never use `finalized` commitment when fetching a blockhash?

`finalized` lags the current tip of the chain by approximately 32 slots — roughly 13 seconds at 400ms per slot. A blockhash is valid for 150 slots (~60 seconds), so fetching a finalized blockhash is not immediately fatal, but it creates a time pressure problem: by the time you build, sign, and submit the transaction, a meaningful fraction of the blockhash's valid window has already elapsed. Under any latency or retry scenario, you risk submitting a transaction with an expired blockhash.

Use `confirmed` instead. It is only 1–2 slots behind the processed tip, well within safety margin, and confirmed blocks have already passed the supermajority vote threshold so they will not be rolled back under normal conditions.

### What happens when a Jito leader skips their slot?

Jito bundles are only eligible for inclusion in a specific leader's slot — they are submitted to the block engine with the expectation that the scheduled Jito-connected leader will pick them up. If that leader skips their slot (fails to produce a block), the bundle is silently dropped. The block engine does not requeue it.

STFU detects this via the `SlotStream`: if the slot assigned to the next Jito leader advances past that leader's window without a corresponding block, the `LifecycleTracker` marks all associated signatures as `dropped` (no processed confirmation within 150 slots). The correct recovery is to re-query `getNextScheduledLeader`, rebuild the bundle against a fresh `confirmed` blockhash, re-run the tip agent for updated context, and resubmit.

---

## Note on devnet

The Yellowstone slot stream and lifecycle tracker work against any Solana cluster. Jito bundle submission requires mainnet — the Jito block engine does not operate on devnet. To test the stream and tracker in isolation without spending SOL, point `RPC_URL` and `GEYSER_ENDPOINT` at a devnet Geyser provider and comment out the bundle submission step in `src/demo.ts`.

---

## License

MIT
