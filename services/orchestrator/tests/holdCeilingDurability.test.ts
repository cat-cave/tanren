import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BatchInfraHoldCeiling } from "../src/engine/merge/batchInfraHoldCeiling.js";
import { type HoldCeilingStore, InMemoryHoldCeilingStore } from "../src/engine/merge/holdCeilingStore.js";
import { RecoverableDriveHoldCeiling } from "../src/engine/merge/recoverableDriveHold.js";
import { alertRetryAfterMs, RECOVERABLE_RETRY_DELAYS_MS } from "../src/engine/merge/retrySchedule.js";

// Audit RC-7 (in-memory hold-ceiling durability gap) + the no-timeouts reframe: the two
// merge runaway guards used to live in process-local Maps AND fire on a fixed attempt COUNT.
// They now (a) PERSIST to a backing store that survives a restart, and (b) fire the loud
// non-recovery alert on a PROGRESS signal — the SAME infra-failure SIGNATURE persisting with
// no progress across the re-drives — never on a count. These tests prove BOTH: the persisted
// signature history survives a re-construction (≈ a restart), so the non-recovery decision is
// not forgotten; an identical-signature streak alerts; a SHIFTING signature keeps re-driving
// quietly; and a store failure propagates loudly (never a silent reset).
//
// The store is the durable layer (the DB in production, an in-memory store here); the ceiling
// object is the process-local wrapper. Sharing ONE store across two freshly-constructed
// ceilings is exactly "two process lifetimes against the same DB".

describe("RecoverableDriveHoldCeiling — restart survival + progress signal (audit RC-7 / no-timeouts)", () => {
  it("re-reads the persisted signature history after a restart, so sustained non-recovery still fires", async () => {
    const store = new InMemoryHoldCeilingStore();
    const queueId = "queue_flapping";
    const sig = "MergeTransientError:gateway 504";

    // Pre-restart process: a couple of IDENTICAL infra holds (no progress) — but not yet a
    // proven fixed point under the immediate-repeat read until the signature recurs.
    const before = new RecoverableDriveHoldCeiling(store);
    const first = await before.next(queueId, sig);
    expect(first.sustainedNonRecovery).toBe(false);
    expect(first.retryAfterMs).toBeDefined();

    // RESTART: a brand-new ceiling over the SAME store. The persisted signature history is NOT
    // forgotten — the identical signature recurs → a fixed point → the loud non-recovery alert.
    const after = new RecoverableDriveHoldCeiling(store);
    const next = await after.next(queueId, sig);
    expect(next.sustainedNonRecovery).toBe(true);
    // The alert keeps re-driving (never abandons): it still returns the longer alert backoff.
    expect(next.retryAfterMs).toBe(alertRetryAfterMs);
    // The attempt count rides along as TELEMETRY only (it survived the restart: 1 → 2).
    expect(next.attempts).toBe(2);
  });

  it("a SHIFTING infra signature keeps re-driving quietly (a recovering blip never alerts)", async () => {
    const store = new InMemoryHoldCeilingStore();
    const ceiling = new RecoverableDriveHoldCeiling(store);
    const queueId = "queue_recovering";
    // Every re-drive sees a DIFFERENT infra failure (504 → 502 → reset): genuine progress.
    let last = await ceiling.next(queueId, "MergeTransientError:504");
    expect(last.sustainedNonRecovery).toBe(false);
    last = await ceiling.next(queueId, "MergeTransientError:502");
    expect(last.sustainedNonRecovery).toBe(false);
    last = await ceiling.next(queueId, "RefResetTransientError:connection reset");
    expect(last.sustainedNonRecovery).toBe(false);
    // Each keeps the recoverable (shorter) curve, never the alert backoff.
    expect(last.retryAfterMs).not.toBe(alertRetryAfterMs);
  });

  it("reset clears the persisted history so a recovered candidate starts fresh", async () => {
    const store = new InMemoryHoldCeilingStore();
    const ceiling = new RecoverableDriveHoldCeiling(store);
    const sig = "MergeTransientError:504";
    await ceiling.next("queue_a", sig);
    await ceiling.next("queue_a", sig);
    await ceiling.reset("queue_a");
    // A fresh ceiling (restart) over the same store sees a cleared history → no alert, count 1.
    const fresh = new RecoverableDriveHoldCeiling(store);
    const after = await fresh.next("queue_a", sig);
    expect(after.attempts).toBe(1);
    expect(after.sustainedNonRecovery).toBe(false);
  });

  it("defaults to an in-memory store when none is injected (Pg-free fakes)", async () => {
    const ceiling = new RecoverableDriveHoldCeiling();
    expect((await ceiling.next("q", "sig")).attempts).toBe(1);
  });
});

describe("BatchInfraHoldCeiling — restart survival + progress signal (audit RC-7 / no-timeouts)", () => {
  it("re-reads the persisted signature history after a restart, so sustained non-recovery still fires", async () => {
    const store = new InMemoryHoldCeilingStore();
    const projectId = "project_outage";
    const sig = "batch check threw: secondary rate limit (403)";

    // Pre-restart: one identical infra hold (not yet a proven fixed point).
    const before = new BatchInfraHoldCeiling(store);
    const recorded = await before.record(projectId, sig);
    expect(recorded.sustainedNonRecovery).toBe(false);
    expect(recorded.holds).toBe(1);

    // RESTART: a fresh ceiling over the SAME store sees the identical signature recur → the
    // terminal non-recovery alert, instead of forgetting the streak and never escalating.
    const after = new BatchInfraHoldCeiling(store);
    const terminal = await after.record(projectId, sig);
    expect(terminal.sustainedNonRecovery).toBe(true);
    expect(terminal.holds).toBe(2);
  });

  it("a SHIFTING infra signature never escalates (the outage is genuinely changing)", async () => {
    const ceiling = new BatchInfraHoldCeiling(new InMemoryHoldCeilingStore());
    const projectId = "project_recovering";
    expect((await ceiling.record(projectId, "batch check threw: 504")).sustainedNonRecovery).toBe(false);
    expect((await ceiling.record(projectId, "batch check threw: 502")).sustainedNonRecovery).toBe(false);
    expect((await ceiling.record(projectId, "batch check threw: reset")).sustainedNonRecovery).toBe(false);
  });
});

describe("HoldCeilingStore fail-closed contract (audit RC-7)", () => {
  it("propagates a store read failure loudly rather than silently resetting to zero", async () => {
    // A store whose increment throws (≈ a DB read failure). The ceiling must NOT swallow it
    // into a reset-to-zero count (which would defeat the guard); it must propagate.
    const failing: HoldCeilingStore = {
      increment: () => Promise.reject(new Error("db read failed")),
      recordSignature: () => Promise.reject(new Error("db read failed")),
      clear: () => Promise.resolve(),
    };
    const ceiling = new RecoverableDriveHoldCeiling(failing);
    await expect(ceiling.next("q", "sig")).rejects.toThrow(/db read failed/u);

    const batch = new BatchInfraHoldCeiling(failing);
    await expect(batch.record("p", "sig")).rejects.toThrow(/db read failed/u);
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
