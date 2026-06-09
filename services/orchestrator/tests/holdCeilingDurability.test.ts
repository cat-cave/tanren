import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BatchInfraHoldCeiling, MAX_BATCH_INFRA_HOLDS } from "../src/engine/merge/batchInfraHoldCeiling.js";
import { type HoldCeilingStore, InMemoryHoldCeilingStore } from "../src/engine/merge/holdCeilingStore.js";
import { RecoverableDriveHoldCeiling } from "../src/engine/merge/recoverableDriveHold.js";
import { alertRetryAfterMs, RECOVERABLE_RETRY_DELAYS_MS } from "../src/engine/merge/retrySchedule.js";

// Audit RC-7 (in-memory hold-ceiling durability gap): the two merge runaway-guard
// counters used to live in process-local Maps, so a rolling deploy / crash-loop LOST
// them and a flapping candidate re-earned its full attempt budget every restart. These
// tests prove the counter is now PERSISTED to a backing store that SURVIVES a restart:
// a counter incremented, then the ceiling RE-CONSTRUCTED (simulating a restart) against
// the SAME durable store, reads the persisted value (not zero) → the cap still fires.
//
// The store is the durable layer (the DB in production, an in-memory store here); the
// ceiling object is the process-local wrapper. Sharing ONE store instance across two
// freshly-constructed ceilings is exactly "two process lifetimes against the same DB".

describe("RecoverableDriveHoldCeiling — restart survival (audit RC-7)", () => {
  it("re-reads the persisted attempt count after a restart, so the cap fires", async () => {
    // The store is the durable backing layer (≈ the DB); the ceiling is process-local.
    const store = new InMemoryHoldCeilingStore();
    const queueId = "queue_flapping";

    // Pre-restart process: burn attempts up to one below the cap (cap = 5).
    const before = new RecoverableDriveHoldCeiling(store);
    let last = await before.next(queueId);
    for (let i = 2; i <= 4; i += 1) {
      last = await before.next(queueId);
    }
    expect(last.attempts).toBe(4);
    // Still under the cap — a recoverable hold (a retryAfterMs is returned).
    expect(last.retryAfterMs).toBeDefined();

    // RESTART: a brand-new ceiling object (the process restarted) over the SAME store.
    const after = new RecoverableDriveHoldCeiling(store);
    const next = await after.next(queueId);

    // The counter did NOT reset to 1 — it continued from the persisted 4 → 5 = the cap,
    // so the loud ceiling alert fires (no retryAfterMs) instead of re-granting the budget.
    expect(next.attempts).toBe(5);
    expect(next.retryAfterMs).toBeUndefined();
  });

  it("reset clears the persisted counter so a recovered candidate starts fresh", async () => {
    const store = new InMemoryHoldCeilingStore();
    const ceiling = new RecoverableDriveHoldCeiling(store);
    await ceiling.next("queue_a");
    await ceiling.next("queue_a");
    await ceiling.reset("queue_a");
    // A fresh ceiling (restart) over the same store sees a cleared counter → back to 1.
    const fresh = new RecoverableDriveHoldCeiling(store);
    expect((await fresh.next("queue_a")).attempts).toBe(1);
  });

  it("defaults to an in-memory store when none is injected (Pg-free fakes)", async () => {
    const ceiling = new RecoverableDriveHoldCeiling();
    expect((await ceiling.next("q")).attempts).toBe(1);
  });
});

describe("BatchInfraHoldCeiling — restart survival (audit RC-7)", () => {
  it("re-reads the persisted consecutive-hold count after a restart, so the cap fires", async () => {
    const store = new InMemoryHoldCeilingStore();
    const projectId = "project_outage";

    // Pre-restart: record up to one below the cap.
    const before = new BatchInfraHoldCeiling(MAX_BATCH_INFRA_HOLDS, store);
    let recorded = await before.record(projectId);
    for (let i = 2; i < MAX_BATCH_INFRA_HOLDS; i += 1) {
      recorded = await before.record(projectId);
    }
    expect(recorded.reached).toBe(false);
    expect(recorded.holds).toBe(MAX_BATCH_INFRA_HOLDS - 1);

    // RESTART: a fresh ceiling over the SAME store reaches the cap on the next hold,
    // instead of restarting the streak at 1 and never escalating.
    const after = new BatchInfraHoldCeiling(MAX_BATCH_INFRA_HOLDS, store);
    const terminal = await after.record(projectId);
    expect(terminal.reached).toBe(true);
    expect(terminal.holds).toBe(MAX_BATCH_INFRA_HOLDS);
  });
});

describe("HoldCeilingStore fail-closed contract (audit RC-7)", () => {
  it("propagates a store read failure loudly rather than silently resetting to zero", async () => {
    // A store whose increment throws (≈ a DB read failure). The ceiling must NOT swallow
    // it into a reset-to-zero count (which would defeat the ceiling); it must propagate.
    const failing: HoldCeilingStore = {
      increment: () => Promise.reject(new Error("db read failed")),
      clear: () => Promise.resolve(),
    };
    const ceiling = new RecoverableDriveHoldCeiling(failing);
    await expect(ceiling.next("q")).rejects.toThrow(/db read failed/u);

    const batch = new BatchInfraHoldCeiling(MAX_BATCH_INFRA_HOLDS, failing);
    await expect(batch.record("p")).rejects.toThrow(/db read failed/u);
  });
});

describe("retrySchedule — single source of truth (audit RC-7 consolidation)", () => {
  it("exports the backoff curve and the alert-retry delay", () => {
    expect(RECOVERABLE_RETRY_DELAYS_MS).toEqual([3_000, 10_000, 30_000, 60_000]);
    expect(alertRetryAfterMs).toBe(60_000);
  });

  const mergeDir = join(import.meta.dirname, "../src/engine/merge");

  it("is the ONLY definition of the retry-schedule magic numbers in engine/merge/*", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(mergeDir)) {
      if (!file.endsWith(".ts") || file === "retrySchedule.ts") continue;
      const text = readFileSync(join(mergeDir, file), "utf8");
      // The alert-retry literal (`60_000` / `60000`) must not be RE-DEFINED outside
      // retrySchedule.ts — every backoff path imports `alertRetryAfterMs` instead.
      if (/\b60_?000\b/u.test(text)) offenders.push(`${file}: re-defines the 60_000 alert-retry literal`);
      // The schedule literal `[3_000, 10_000, 30_000, 60_000]` (with either separator).
      if (/\[\s*3_?000\s*,\s*10_?000\s*,\s*30_?000\s*,\s*60_?000\s*\]/u.test(text)) {
        offenders.push(`${file}: re-defines the recoverable retry-schedule literal`);
      }
    }
    expect(offenders, `move these to retrySchedule.ts: ${offenders.join("; ")}`).toEqual([]);
  });
});
