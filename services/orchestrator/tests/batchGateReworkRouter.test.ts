// Unit tests for the PgBatchGateReworkRouter (v35 — the batch-gate-fail-strand fix).
// The router re-authors a GATE-fail bisect culprit on the never-discard
// re-plan-with-steering mechanism (carrying the batch gate error), bounded by its own
// rework budget. These tests inject the enqueuer + prior-rework counter + an org resolver
// + a recording append + a recording pool (for the spec-status park) so the bound + the
// no-blind-rework steering are verified WITHOUT a DB or any scope globals.

import { describe, expect, it } from "vitest";
import type pg from "pg";
import { PgBatchGateReworkRouter } from "../src/engine/merge/batchGateReworkRouter.js";
import {
  gateErrorSignature,
  type ReplanEnqueuer,
} from "../src/engine/workflow/reviewMerge/conflictResolver/replanRouter.js";
import type { MergeQueueEntry } from "../src/engine/contracts/mergeCoordinator.js";
import { InMemoryRunStateWriter } from "./fixtures/inMemoryRunStateWriter.js";

const ORG = "org_test";
const PROJECT = "project_test";

function culprit(specId: string): MergeQueueEntry {
  return {
    queueId: `q_${specId}`,
    runId: `run_${specId}`,
    specId,
    prUrl: `https://example.test/pr/${specId}`,
    prNumber: 7,
    dependsOn: [],
    priority: "tbd",
    orderKey: 0,
  };
}

interface Appended {
  eventType: string;
  payload: Record<string, unknown>;
}

/** A recording pool that captures only the spec-status park UPDATE (the router's only DB write here). */
function makeStatusPool(statusWrites: { specId: string; status: string }[]): pg.Pool {
  // eslint-disable-next-line @typescript-eslint/require-await
  const query = async (text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = String(text);
    if (sql.includes("UPDATE specs SET status")) {
      const m = /status\s*=\s*'([a-z_]+)'/u.exec(sql);
      statusWrites.push({ specId: String(params?.[0]), status: m?.[1] ?? "?" });
      return { rows: [], rowCount: 1 };
    }
    // BEGIN/COMMIT/SET LOCAL no-ops.
    return { rows: [], rowCount: 0 };
  };
  return {
    query,
    // eslint-disable-next-line @typescript-eslint/require-await
    connect: async () => ({ query, release: () => {} }),
  } as unknown as pg.Pool;
}

function makeRouter(opts: {
  enqueuer: ReplanEnqueuer;
  /** The spec's prior gate-error SIGNATURES (oldest→newest) the convergence detector reads. */
  priorReworks: string[];
  appended: Appended[];
  statusWrites: { specId: string; status: string }[];
}): PgBatchGateReworkRouter {
  return new PgBatchGateReworkRouter({
    pool: makeStatusPool(opts.statusWrites),
    // Audit D-R3.2: runStateWriter is REQUIRED on the type. The test's `appendEvent`
    // injection still wins (the production routing path is exercised in the conformance
    // suite), so the in-memory writer here only satisfies the type — it is never invoked.
    runStateWriter: new InMemoryRunStateWriter(),
    enqueuer: opts.enqueuer,
    priorReworks: () => Promise.resolve(opts.priorReworks),
    resolveOrg: () => Promise.resolve(ORG),
    // eslint-disable-next-line @typescript-eslint/require-await
    appendEvent: async (_orgId, event) => {
      opts.appended.push({ eventType: event.eventType, payload: event.payload as Record<string, unknown> });
    },
  });
}

describe("PgBatchGateReworkRouter — gate-fail → writer rework, bounded", () => {
  it("re-authors the culprit (carrying the gate error as steering) + records reworked when under the budget", async () => {
    const enqueued: Array<{ specId: string; steeringNote: string; reopenStatus: string }> = [];
    const enqueuer: ReplanEnqueuer = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async enqueue(input) {
        enqueued.push({ specId: input.specId, steeringNote: input.steeringNote, reopenStatus: input.reopenStatus });
        return { replanRunId: "run_rework_1", plannerTaskId: "task_1" };
      },
    };
    const appended: Appended[] = [];
    const statusWrites: { specId: string; status: string }[] = [];
    const router = makeRouter({ enqueuer, priorReworks: [], appended, statusWrites });

    const gateError = "tier merge / step lint: Parsing error on vitest.stryker.config.ts";
    const disposition = await router.routeGateFailToRework({
      projectId: PROJECT,
      culprit: culprit("spec_x"),
      gateError,
    });

    expect(disposition).toBe("reworked");
    // A fresh rework run was enqueued, re-opening the spec to `open` and carrying the ACTUAL
    // gate error in the steering (no_silent_fallback — never rework blind).
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.reopenStatus).toBe("open");
    expect(enqueued[0]?.steeringNote).toContain(gateError);
    // The observable routing event is recorded as `reworked` + a replan_queued lineage.
    const routed = appended.find((e) => e.eventType === "merge.batch.gate_rework_routed");
    expect(routed?.payload.disposition).toBe("reworked");
    expect(routed?.payload.gateError).toBe(gateError);
    expect(appended.some((e) => e.eventType === "recovery.replan_queued")).toBe(true);
    // It did NOT park the spec at needs_attention.
    expect(statusWrites.some((w) => w.status === "needs_attention")).toBe(false);
  });

  it("ESCALATES to needs_attention (no further rework) at a FIXED POINT — the SAME gate error recurs", async () => {
    let enqueueCalls = 0;
    const enqueuer: ReplanEnqueuer = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async enqueue() {
        enqueueCalls += 1;
        return { replanRunId: "run_rework_n", plannerTaskId: "task_n" };
      },
    };
    const appended: Appended[] = [];
    const statusWrites: { specId: string; status: string }[] = [];
    const stuckError = "still failing the integrated gate";
    // The spec was re-worked against this EXACT gate error REPEATEDLY (a cycle: the identical
    // error recurring beyond a single transient repeat) — re-working again would reproduce it
    // identically (a proven fixed point), so the detector escalates (no count).
    const router = makeRouter({
      enqueuer,
      priorReworks: [gateErrorSignature(stuckError), gateErrorSignature(stuckError)],
      appended,
      statusWrites,
    });

    const disposition = await router.routeGateFailToRework({
      projectId: PROJECT,
      culprit: culprit("spec_stuck"),
      gateError: stuckError,
    });

    expect(disposition).toBe("escalated");
    // No further rework run was enqueued (fixed point — never a hot-loop).
    expect(enqueueCalls).toBe(0);
    // The spec was parked at needs_attention (loud, frees the slot).
    expect(statusWrites.some((w) => w.status === "needs_attention")).toBe(true);
    const routed = appended.find((e) => e.eventType === "merge.batch.gate_rework_routed");
    expect(routed?.payload.disposition).toBe("escalated");
    const park = appended.find((e) => e.eventType === "dag.spec.needs_attention");
    expect(park?.payload.reason).toBe("persistent_failure");
  });

  it("re-works UNBOUNDED while the gate error keeps CHANGING — many prior reworks, a NEW error ⇒ rework not escalate", async () => {
    let enqueueCalls = 0;
    const enqueuer: ReplanEnqueuer = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async enqueue() {
        enqueueCalls += 1;
        return { replanRunId: "run_rework_p", plannerTaskId: "task_p" };
      },
    };
    const appended: Appended[] = [];
    const statusWrites: { specId: string; status: string }[] = [];
    // Five prior reworks, each a DIFFERENT gate error — the writer is fixing one failure and
    // surfacing the next (progress). The current error is different again ⇒ keep re-working,
    // far past any old fixed cap of 3.
    const priorReworks = ["err-a", "err-b", "err-c", "err-d", "err-e"].map((e) => gateErrorSignature(e));
    const router = makeRouter({ enqueuer, priorReworks, appended, statusWrites });

    const disposition = await router.routeGateFailToRework({
      projectId: PROJECT,
      culprit: culprit("spec_progressing"),
      gateError: "err-f (a brand new, different failure)",
    });

    expect(disposition).toBe("reworked");
    expect(enqueueCalls).toBe(1);
    expect(statusWrites.some((w) => w.status === "needs_attention")).toBe(false);
  });

  it("ESCALATES (never silently strands) when the rework run cannot be enqueued", async () => {
    const enqueuer: ReplanEnqueuer = {
      enqueue() {
        return Promise.reject(new Error("planner unavailable"));
      },
    };
    const appended: Appended[] = [];
    const statusWrites: { specId: string; status: string }[] = [];
    const router = makeRouter({ enqueuer, priorReworks: [], appended, statusWrites });

    const disposition = await router.routeGateFailToRework({
      projectId: PROJECT,
      culprit: culprit("spec_y"),
      gateError: "gate failed",
    });

    expect(disposition).toBe("escalated");
    expect(statusWrites.some((w) => w.status === "needs_attention")).toBe(true);
    const park = appended.find((e) => e.eventType === "dag.spec.needs_attention");
    expect(park?.payload.reason).toBe("persistent_failure");
  });
});
