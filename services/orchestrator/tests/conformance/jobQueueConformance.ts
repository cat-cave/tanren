// Seam conformance suite for the JobQueue contract
// (`engine/contracts/jobQueue.ts`). Reusable behavior spec invoked once per
// implementation via `describeJobQueueConformance`. Asserts the queue contract
// through the public API + observable state only — enqueue/claim is atomic and
// once-only, claim-on-empty yields undefined, complete/fail are terminal (the
// job is never re-claimed), and claim is mutually exclusive across slots.
// Never inspects private fields or mock-call counts. The same fixtures
// validate the in-memory fake and the Postgres impl over an in-memory pool.
// Track C §2 of docs/architecture/portability-and-longevity.md.
import { describe, expect, it } from "vitest";
import type { JobQueue } from "../../src/engine/contracts/jobQueue.js";

export interface JobQueueConformanceHarness {
  /** Build a fresh, empty JobQueue under test. */
  make(): JobQueue<{ n: number }>;
}

/**
 * Behavior spec every JobQueue implementation must pass. Call once per impl:
 *
 *   describeJobQueueConformance("FakeJobQueue", { make: () => new FakeJobQueue() });
 */
export function describeJobQueueConformance(label: string, harness: JobQueueConformanceHarness): void {
  describe(`JobQueue conformance: ${label}`, () => {
    it("enqueue returns an envelope with an id and zero attempts", async () => {
      const queue = harness.make();
      const job = await queue.enqueue({ taskKind: "plan", payload: { n: 1 } });
      expect(typeof job.id).toBe("string");
      expect(job.id.length).toBeGreaterThan(0);
      expect(job.taskKind).toBe("plan");
      expect(job.payload).toEqual({ n: 1 });
      expect(job.attempts).toBe(0);
    });

    it("claim on an empty queue returns undefined", async () => {
      const queue = harness.make();
      await expect(queue.claim("plan")).resolves.toBeUndefined();
    });

    it("claim returns a queued job and increments its attempt count", async () => {
      const queue = harness.make();
      const enqueued = await queue.enqueue({ taskKind: "plan", payload: { n: 7 } });
      const claimed = await queue.claim("plan");
      expect(claimed?.id).toBe(enqueued.id);
      expect(claimed?.payload).toEqual({ n: 7 });
      expect(claimed?.attempts).toBe(1);
    });

    it("claim is once-only — a claimed job is not handed out again", async () => {
      const queue = harness.make();
      await queue.enqueue({ taskKind: "plan", payload: { n: 1 } });
      const first = await queue.claim("plan");
      expect(first).toBeDefined();
      // The same job must not be re-claimed while it is running.
      await expect(queue.claim("plan")).resolves.toBeUndefined();
    });

    it("claim is mutually exclusive across two enqueued jobs", async () => {
      const queue = harness.make();
      const a = await queue.enqueue({ taskKind: "plan", payload: { n: 1 } });
      const b = await queue.enqueue({ taskKind: "plan", payload: { n: 2 } });
      const first = await queue.claim("plan");
      const second = await queue.claim("plan");
      const claimedIds = new Set([first?.id, second?.id]);
      // Each enqueued job is claimed exactly once — never the same one twice.
      expect(claimedIds).toEqual(new Set([a.id, b.id]));
      await expect(queue.claim("plan")).resolves.toBeUndefined();
    });

    it("claim only matches the requested taskKind", async () => {
      const queue = harness.make();
      await queue.enqueue({ taskKind: "write", payload: { n: 1 } });
      await expect(queue.claim("plan")).resolves.toBeUndefined();
      await expect(queue.claim("write")).resolves.toBeDefined();
    });

    it("complete is terminal — a completed job is never re-claimed", async () => {
      const queue = harness.make();
      await queue.enqueue({ taskKind: "plan", payload: { n: 1 } });
      const claimed = await queue.claim("plan");
      await queue.complete(claimed!.id);
      await expect(queue.claim("plan")).resolves.toBeUndefined();
    });

    it("fail is terminal — a failed job is never re-claimed", async () => {
      const queue = harness.make();
      await queue.enqueue({ taskKind: "plan", payload: { n: 1 } });
      const claimed = await queue.claim("plan");
      await queue.fail(claimed!.id, { kind: "boom", message: "exploded" });
      await expect(queue.claim("plan")).resolves.toBeUndefined();
    });

    it("failQueuedForRun makes still-queued jobs for that run unclaimable", async () => {
      const queue = harness.make();
      await queue.enqueue({ runId: "run_x", taskKind: "plan", payload: { n: 1 } });
      await queue.failQueuedForRun("run_x", { kind: "run_failed", message: "aborted" });
      await expect(queue.claim("plan", { runId: "run_x" })).resolves.toBeUndefined();
    });

    it("scopes claim by runId when requested", async () => {
      const queue = harness.make();
      await queue.enqueue({ runId: "run_a", taskKind: "plan", payload: { n: 1 } });
      // Asking for a different run finds nothing.
      await expect(queue.claim("plan", { runId: "run_b" })).resolves.toBeUndefined();
      // Asking for the right run finds the job.
      const claimed = await queue.claim("plan", { runId: "run_a" });
      expect(claimed?.runId).toBe("run_a");
    });
  });
}
