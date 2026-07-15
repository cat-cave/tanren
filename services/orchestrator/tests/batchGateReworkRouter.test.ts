// Unit tests for the PgBatchGateReworkRouter (v35 — the batch-gate-fail-strand fix).
// The router re-authors a GATE-fail bisect culprit on the never-discard
// re-plan-with-steering mechanism (carrying the batch gate error), bounded by its own
// rework budget. Tests inject enqueuer + prior-rework signatures + a recording atomic
// RunStateWriter (sole park/event authority — no appendEvent split seam).

import { describe, expect, it } from "vitest";
import type pg from "pg";
import { PgBatchGateReworkRouter } from "../src/engine/merge/batchGateReworkRouter.js";
import { SpecNotRunnableError } from "../src/engine/workflow/projectSpecErrors.js";
import { SpecNotPreparedForRecoveryError } from "../src/engine/workflow/specNotPreparedForRecoveryError.js";
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

/** Pool for org-scoped active-owner / status readback (no raw status UPDATE path). */
function makeStatusPool(
  opts: {
    specStatusById?: Map<string, string>;
    liveRunsBySpec?: Map<string, { run_id: string; status: string }>;
    defaultSpecStatus?: string;
  } = {},
): pg.Pool {
  // eslint-disable-next-line @typescript-eslint/require-await
  const query = async (text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = String(text);
    if (sql.includes("SELECT status FROM specs")) {
      const status = opts.specStatusById?.get(String(params?.[0])) ?? opts.defaultSpecStatus ?? "open";
      return { rows: [{ status }], rowCount: 1 };
    }
    if (sql.includes("FROM runs") && sql.includes("status IN")) {
      const live = opts.liveRunsBySpec?.get(String(params?.[0]));
      if (live === undefined || !["queued", "running", "paused"].includes(live.status)) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [live], rowCount: 1 };
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
  priorReworks: string[];
  appended: Appended[];
  statusWrites: { specId: string; status: string }[];
  liveRunsBySpec?: Map<string, { run_id: string; status: string }>;
  /** Current status for atomic park notFromStatuses + durable readback. */
  specStatus?: string;
}): PgBatchGateReworkRouter {
  const writer = new InMemoryRunStateWriter({
    forwardAppend: (event) => {
      opts.appended.push({ eventType: event.eventType, payload: event.payload as Record<string, unknown> });
    },
    forwardUpdateSpecWithEvent: (input) => {
      opts.statusWrites.push({ specId: input.spec.specId, status: input.spec.status });
    },
  });
  writer.updateSpecCurrentStatus = opts.specStatus ?? "open";
  return new PgBatchGateReworkRouter({
    pool: makeStatusPool({
      ...(opts.liveRunsBySpec !== undefined && { liveRunsBySpec: opts.liveRunsBySpec }),
      defaultSpecStatus: opts.specStatus ?? "open",
    }),
    runStateWriter: writer,
    enqueuer: opts.enqueuer,
    priorReworks: () => Promise.resolve(opts.priorReworks),
    resolveOrg: () => Promise.resolve(ORG),
  });
}

describe("PgBatchGateReworkRouter — gate-fail → writer rework, bounded", () => {
  it("re-authors the culprit (carrying the gate error as steering) + records reworked when under the budget", async () => {
    const enqueued: Array<{ specId: string; steeringNote: string }> = [];
    const enqueuer: ReplanEnqueuer = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async enqueue(input) {
        enqueued.push({ specId: input.specId, steeringNote: input.steeringNote });
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

    expect(disposition).toEqual({
      kind: "owned",
      receipt: {
        kind: "writer_rework",
        specId: "spec_x",
        run: { kind: "enqueued", replanRunId: "run_rework_1", plannerTaskId: "task_1" },
      },
    });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.steeringNote).toContain(gateError);
    const routed = appended.find((e) => e.eventType === "merge.batch.gate_rework_routed");
    expect(routed?.payload.disposition).toBe("reworked");
    expect(routed?.payload.gateError).toBe(gateError);
    expect(appended.some((e) => e.eventType === "recovery.replan_queued")).toBe(true);
    expect(statusWrites.some((w) => w.status === "needs_attention")).toBe(false);
  });

  it("returns an already-running receipt only when a live, in-progress run is independently proven", async () => {
    const enqueuer: ReplanEnqueuer = {
      enqueue(input) {
        return Promise.reject(new SpecNotRunnableError(input.specId, "in_flight"));
      },
    };
    const appended: Appended[] = [];
    const statusWrites: { specId: string; status: string }[] = [];
    const liveRunsBySpec = new Map([["spec_claimed", { run_id: "run_claimed_live", status: "running" }]]);
    const router = makeRouter({ enqueuer, priorReworks: [], appended, statusWrites, liveRunsBySpec });

    const recovery = await router.routeGateFailToRework({
      projectId: PROJECT,
      culprit: culprit("spec_claimed"),
      gateError: "gate failed",
    });

    expect(recovery).toEqual({
      kind: "owned",
      receipt: {
        kind: "writer_rework",
        specId: "spec_claimed",
        run: { kind: "already_running", runId: "run_claimed_live" },
      },
    });
    expect(appended.some((e) => e.eventType === "recovery.replan_queued")).toBe(false);
    expect(statusWrites).toEqual([]);
  });

  it("FAIL-CLOSED: SpecNotRunnableError without a live run parks (never fabricates already_running)", async () => {
    const enqueuer: ReplanEnqueuer = {
      enqueue(input) {
        return Promise.reject(new SpecNotRunnableError(input.specId, "merged"));
      },
    };
    const appended: Appended[] = [];
    const statusWrites: { specId: string; status: string }[] = [];
    const router = makeRouter({ enqueuer, priorReworks: [], appended, statusWrites });

    const recovery = await router.routeGateFailToRework({
      projectId: PROJECT,
      culprit: culprit("spec_claimed"),
      gateError: "gate failed",
    });

    expect(recovery.kind).toBe("parked");
    expect(statusWrites.some((w) => w.status === "needs_attention")).toBe(true);
  });

  it("FAIL-CLOSED: a terminal merged culprit cannot own writer rework", async () => {
    const enqueuer: ReplanEnqueuer = {
      enqueue: (input) =>
        Promise.reject(new SpecNotPreparedForRecoveryError(input.specId, "not_recoverable", "merged")),
    };
    const appended: Appended[] = [];
    const statusWrites: { specId: string; status: string }[] = [];
    // Spec is open for the park attempt (prepare refused for other reasons in production;
    // here we still park loud unless concurrent terminal blocks the flip).
    const router = makeRouter({ enqueuer, priorReworks: [], appended, statusWrites });

    const recovery = await router.routeGateFailToRework({
      projectId: PROJECT,
      culprit: culprit("spec_merged"),
      gateError: "gate failed",
    });

    expect(recovery.kind).toBe("parked");
    expect(String((recovery as { message: string }).message)).toMatch(/not a recoverable recovery source/u);
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

    expect(disposition).toMatchObject({
      kind: "parked",
      receipt: { kind: "needs_attention", specId: "spec_stuck", source: "writer_rework" },
    });
    expect(enqueueCalls).toBe(0);
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
    const priorReworks = ["err-a", "err-b", "err-c", "err-d", "err-e"].map((e) => gateErrorSignature(e));
    const router = makeRouter({ enqueuer, priorReworks, appended, statusWrites });

    const disposition = await router.routeGateFailToRework({
      projectId: PROJECT,
      culprit: culprit("spec_progressing"),
      gateError: "err-f (a brand new, different failure)",
    });

    expect(disposition.kind).toBe("owned");
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

    expect(disposition).toMatchObject({
      kind: "parked",
      receipt: { kind: "needs_attention", specId: "spec_y", source: "writer_rework" },
    });
    expect(statusWrites.some((w) => w.status === "needs_attention")).toBe(true);
    const park = appended.find((e) => e.eventType === "dag.spec.needs_attention");
    expect(park?.payload.reason).toBe("persistent_failure");
  });

  it("CONCURRENT CANCEL: zero status change, zero park event, terminal_noop (not parking complete)", async () => {
    const enqueuer: ReplanEnqueuer = {
      enqueue() {
        return Promise.reject(new Error("planner unavailable"));
      },
    };
    const appended: Appended[] = [];
    const statusWrites: { specId: string; status: string }[] = [];
    const router = makeRouter({
      enqueuer,
      priorReworks: [],
      appended,
      statusWrites,
      specStatus: "cancelled",
    });

    const recovery = await router.routeGateFailToRework({
      projectId: PROJECT,
      culprit: culprit("spec_cancel_race"),
      gateError: "gate failed",
    });

    expect(recovery).toMatchObject({ kind: "terminal_noop", status: "cancelled" });
    expect(statusWrites).toEqual([]);
    expect(appended.some((e) => e.eventType === "dag.spec.needs_attention")).toBe(false);
  });
});
