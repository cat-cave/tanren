// (autonomy-engine.md §2d) — serialization hardening: `recoverStaleClaims` is
// LEASE-GUARDED. A FRESH `merging` claim (a coordinator actively driving a merge)
// must SURVIVE a concurrent coordinate pass — only a STALE claim (a coordinator
// that genuinely crashed, claim older than the lease) is reclaimed. Without the
// lease, a second coordinator would reset + DOUBLE-DRIVE an in-flight merge.
//
// Driven against the in-memory model (whose recovery semantics mirror the pg impl's
// lease query). The clock is injectable so the lease boundary is deterministic.

import { describe, expect, it } from "vitest";
import { InMemoryMergeQueueModel } from "./conformance/fakes/inMemoryMergeQueue.js";

const LEASE_MS = 15 * 60 * 1000;

describe("recoverStaleClaims lease guard (P2d serialization hardening)", () => {
  it("a FRESH merging claim SURVIVES a concurrent coordinate pass (not reclaimed)", async () => {
    const queue = new InMemoryMergeQueueModel();
    let now = 1_000_000;
    queue.now = () => now;
    queue.seed({ runId: "run_a", specId: "spec_a", dependsOn: [], priority: "tbd" });
    const snap = await queue.loadSnapshot("p");
    const claimed = await queue.claim(snap.entries[0].queueId);
    expect(claimed).toBe(true);
    expect(queue.statusOf("run_a")).toBe("merging");

    // A concurrent pass a few seconds later (well within the lease) recovers NOTHING.
    now += 5_000;
    const recovered = await queue.recoverStaleClaims("p");
    expect(recovered).toBe(0);
    // The fresh claim is intact — the other coordinator cannot double-drive it.
    expect(queue.statusOf("run_a")).toBe("merging");
  });

  it("a STALE merging claim (older than the lease) IS reclaimed → queued", async () => {
    const queue = new InMemoryMergeQueueModel();
    let now = 1_000_000;
    queue.now = () => now;
    queue.seed({ runId: "run_a", specId: "spec_a", dependsOn: [], priority: "tbd" });
    const snap = await queue.loadSnapshot("p");
    await queue.claim(snap.entries[0].queueId);

    // Advance past the lease (the driving coordinator is presumed crashed).
    now += LEASE_MS + 1;
    const recovered = await queue.recoverStaleClaims("p");
    expect(recovered).toBe(1);
    // Reclaimed so the queue makes progress — a new pass can re-drive it.
    expect(queue.statusOf("run_a")).toBe("queued");
  });
});
