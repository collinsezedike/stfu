import Client, {
  ChannelOptions,
  CommitmentLevel,
  SubscribeRequest,
  SubscribeUpdate,
} from "@triton-one/yellowstone-grpc";
import { EventEmitter } from "node:events";

export interface SlotUpdate {
  slot: number;
  parentSlot: number;
  status: "processed" | "confirmed" | "finalized";
  timestamp: number;
}

export class SlotStream extends EventEmitter {
  private client: Client;
  private running = false;
  private reconnectDelay = 1_000;
  private readonly maxReconnectDelay = 30_000;
  private reconnectAttempts = 0;

  constructor(
    private readonly endpoint: string,
    private readonly token: string
  ) {
    super();
    this.client = this.createClient();
  }

  private createClient(): Client {
    const opts: ChannelOptions = {};
    return new Client(this.endpoint, this.token, opts);
  }

  async start(): Promise<void> {
    this.running = true;
    await this.connect();
  }

  stop(): void {
    this.running = false;
  }

  private async connect(): Promise<void> {
    while (this.running) {
      try {
        await this.subscribe();
        if (this.running) {
          console.log("[stream] Stream ended cleanly, reconnecting...");
          await this.backoff();
        }
      } catch (err) {
        if (!this.running) break;
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
        this.reconnectAttempts++;
        this.emit("reconnecting", this.reconnectAttempts);
        console.error(`[stream] Error (attempt ${this.reconnectAttempts}):`, err);
        await this.backoff();
        this.client = this.createClient();
      }
    }
  }

  private async subscribe(): Promise<void> {
    const stream = await this.client.subscribe();

    return new Promise<void>((resolve, reject) => {
      stream.on("data", (update: SubscribeUpdate) => {
        // Reset backoff on any successful data — we're clearly connected
        this.reconnectDelay = 1_000;
        this.reconnectAttempts = 0;

        if (update.slot) {
          const s = update.slot;
          const status = this.mapStatus(s.status ?? 0);
          if (status) {
            this.emit("slot", {
              slot: Number(s.slot),
              parentSlot: Number(s.parent ?? 0),
              status,
              timestamp: Date.now(),
            } satisfies SlotUpdate);
          }
        }
      });

      stream.on("error", reject);
      stream.on("end", resolve);
      stream.on("close", resolve);

      const request: SubscribeRequest = {
        slots: { slots: {} },
        accounts: {},
        transactions: {},
        transactionsStatus: {},
        blocks: {},
        blocksMeta: {},
        entry: {},
        accountsDataSlice: [],
        commitment: CommitmentLevel.PROCESSED,
        ping: undefined,
      };

      // The grpc-js duplex stream's write() signature uses its own internal
      // request type, which doesn't align with the SDK's SubscribeRequest at
      // the TypeScript level. The cast is safe — the runtime type is correct.
      stream.write(
        request as unknown as Parameters<typeof stream.write>[0],
        (err?: Error | null) => {
          if (err) {
            reject(err);
          } else {
            // Emit "connected" only after the subscription write succeeds,
            // not before — callers rely on this event to know the stream is live.
            this.emit("connected");
            console.log("[stream] Connected to Geyser, subscribing to slots...");
          }
        }
      );
    });
  }

  private mapStatus(status: number): SlotUpdate["status"] | null {
    // The @triton-one/yellowstone-grpc SDK normalises the raw proto
    // SlotUpdateStatus enum to processed=0, confirmed=1, finalized=2
    // before surfacing it on the update object.
    switch (status) {
      case 0: return "processed";
      case 1: return "confirmed";
      case 2: return "finalized";
      default: return null;
    }
  }

  private async backoff(): Promise<void> {
    await new Promise<void>((r) => setTimeout(r, this.reconnectDelay));
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      this.maxReconnectDelay
    );
  }
}
