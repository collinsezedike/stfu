import { describe, it, expect, vi, beforeEach } from "vitest";
import { Connection } from "@solana/web3.js";
import { LifecycleTracker } from "../tracker/index.js";

// Minimal Connection mock — only the methods LifecycleTracker calls
function makeConnection() {
  return {
    onSignature: vi.fn().mockReturnValue(1),
    removeSignatureListener: vi.fn().mockResolvedValue(undefined),
    getSignatureStatuses: vi.fn(),
  } as unknown as Connection;
}

describe("LifecycleTracker", () => {
  let connection: ReturnType<typeof makeConnection>;
  let tracker: LifecycleTracker;

  beforeEach(() => {
    connection = makeConnection();
    tracker = new LifecycleTracker(connection as unknown as Connection);
  });

  it("emits 'submitted' immediately on track()", () => {
    const handler = vi.fn();
    tracker.on("submitted", handler);
    tracker.track("sig1", 100);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]![0].status).toBe("submitted");
  });

  it("advances submitted → processed → confirmed → finalized in one cascade", () => {
    const events: string[] = [];
    tracker.on("processed", () => events.push("processed"));
    tracker.on("confirmed", () => events.push("confirmed"));
    tracker.on("finalized", () => events.push("finalized"));

    const lc = tracker.track("sig2", 200);
    // Simulate the WebSocket "finalized" subscription firing
    // advance() cascades through all three stages in one call
    (tracker as unknown as { advance: Function }).advance(lc, "finalized", 210, Date.now());

    expect(events).toEqual(["processed", "confirmed", "finalized"]);
    expect(lc.status).toBe("finalized");
    expect(lc.processedSlot).toBe(210);
    expect(lc.confirmedSlot).toBe(210);
    expect(lc.finalizedSlot).toBe(210);
  });

  it("does not double-advance if already at a later stage", () => {
    const handler = vi.fn();
    tracker.on("processed", handler);

    const lc = tracker.track("sig3", 300);
    const now = Date.now();
    (tracker as unknown as { advance: Function }).advance(lc, "processed", 310, now);
    (tracker as unknown as { advance: Function }).advance(lc, "processed", 311, now + 1);

    // Second call should be a no-op since status is already "processed"
    expect(handler).toHaveBeenCalledOnce();
  });

  it("marks a tx as dropped after DROP_TIMEOUT_SLOTS with no status", async () => {
    const dropped = vi.fn();
    tracker.on("dropped", dropped);

    const lc = tracker.track("sig4", 100);
    tracker.updateSlot(100 + 151); // past the 150-slot window

    // Simulate poll() finding no status
    (connection.getSignatureStatuses as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      value: [null],
    });

    await (tracker as unknown as { poll: () => Promise<void> }).poll();

    expect(dropped).toHaveBeenCalledOnce();
    expect(lc.status).toBe("dropped");
    expect(lc.failureType).toBe("dropped");
  });

  it("classifies a failed tx with BlockhashNotFound", async () => {
    const failed = vi.fn();
    tracker.on("failed", failed);

    const lc = tracker.track("sig5", 400);

    (connection.getSignatureStatuses as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      value: [{ err: { BlockhashNotFound: null }, slot: 401, confirmationStatus: "processed" }],
    });

    await (tracker as unknown as { poll: () => Promise<void> }).poll();

    expect(failed).toHaveBeenCalledOnce();
    expect(lc.status).toBe("failed");
    expect(lc.failureType).toBe("blockhash_expired");
  });
});
