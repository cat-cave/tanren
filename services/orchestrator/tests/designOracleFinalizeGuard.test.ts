// Codex critic #5 — the design-oracle loop stage was the outlier: after a contract was
// verified it inserted a task row + emitted `task.started`, then ran the verdict-event
// append + cost recording + `markTaskDoneWithEvent` OUTSIDE any finalize guard. A throw
// anywhere in that post-insert region left the task row stranded `running` with no
// `task.failed` event — the DAG walker never re-drove and the run stalled silent
// (same shape as apex v51 #640).
//
// THIS SUITE pins the fix. Mirrors `recorderThrowProtection.test.ts`'s pattern (the
// task #35 wider-guard contract) but for the design-oracle stage, which now conforms
// to the demo/triage/convergence shape: the WHOLE post-row body (verdict append +
// cost record + terminal pair) rides inside `runStageBodyWithFinalizeGuard`, so a
// throw ANYWHERE in that chain closes the row loud + emits exactly one `task.failed`
// with a deterministic `failureKind`:
//
//   - `CostRecordError` → `failureKind: "cost_record_failed"`
//   - `EventAppendError` → `failureKind: "event_append_failed"` (PRE-TERMINAL)
/* eslint-disable unicorn/no-thenable */

import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { ActorContext } from "../src/auth/schemas.js";
import type { EventName, EventPayload } from "../src/engine/events/index.js";
import type { CostRecorder } from "../src/engine/costs/index.js";
import { parseDesignContract } from "../src/engine/design/designContract.js";
import { runDesignOracleLoopStage } from "../src/engine/workflow/designOracleLoopStage.js";
import type { SubtaskCostContext } from "../src/engine/workflow/subtaskCost.js";
import { makeDesignOracle } from "./helpers/plannerLoopHelpers.js";
import { InMemoryRunStateWriter } from "./fixtures/inMemoryRunStateWriter.js";

const ORG = "org_finalize_guard";
const PROJECT = "project_test";
const actor: ActorContext = {
  userId: "design-writer-context",
  orgId: ORG,
  projectId: PROJECT,
  scopes: ["platform:admin"],
  source: "local_dev",
};

const oracleContract = () =>
  parseDesignContract({
    version: 1,
    domain: "saas-web",
    identity: "calm ops console",
    intent: "effortless under load",
    principles: ["no AI-slop"],
    constraints: [],
    personaRefs: ["persona_admin"],
    behaviorRefs: ["behavior_invite"],
    dimensions: [{ key: "tokens", label: "Tokens", intent: "restrained", guidance: "", personaRefs: [] }],
  });

// A minimal query client that serves the three design-oracle SELECTs (contract +
// persona + behavior). The stage's post-insert body is what this suite exercises;
// the read side just needs to reach `hasContract: true` so the task row materializes.
class DesignFakePool implements Pick<pg.Pool, "query"> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async query(sql: unknown, params: ReadonlyArray<unknown> = []): Promise<any> {
    const trimmed = String(sql).trim();
    const now = new Date("2026-01-01T00:00:00Z");
    if (trimmed.includes("FROM design_contracts")) {
      const contract = oracleContract();
      return {
        rows: [{ id: "design_1", org_id: ORG, project_id: PROJECT, version: 2, domain: contract.domain, contract }],
        rowCount: 1,
      };
    }
    if (trimmed.includes("FROM personas")) {
      if (String(params[0]) !== "persona_admin") return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            id: "persona_admin",
            scope: "org",
            org_id: ORG,
            project_id: null,
            name: "Admin",
            description: "runs the org",
            metadata: {},
            created_at: now,
            updated_at: now,
          },
        ],
        rowCount: 1,
      };
    }
    if (trimmed.includes("FROM behaviors")) {
      if (String(params[0]) !== "behavior_invite") return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            id: "behavior_invite",
            persona_id: "persona_admin",
            title: "Invite a teammate",
            given: "g",
            when: "w",
            then: "t",
            description: null,
            metadata: {},
            created_at: now,
            updated_at: now,
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  }
}

interface RecordedEvent {
  eventType: EventName;
  payload: Record<string, unknown>;
  taskId: string | undefined;
}

// The same focused harness pattern as `recorderThrowProtection.test.ts`: forward the
// writer's atomic-terminal append back into `events` and honor `throwOnEventTypes`
// so a forced throw at any event surfaces through both the atomic seam and the
// pre-terminal appendEvent path.
class GuardHarness {
  readonly events: RecordedEvent[] = [];
  throwOnEventTypes: ReadonlySet<EventName> = new Set();
  recorderThrows = false;
  readonly pool = new DesignFakePool();
  readonly writer = new InMemoryRunStateWriter({
    forwardAppend: async (input) => {
      if (this.throwOnEventTypes.has(input.eventType as EventName)) {
        throw new Error(`event-append transport failure: ${input.eventType}`);
      }
      this.events.push({
        eventType: input.eventType as EventName,
        payload: input.payload as Record<string, unknown>,
        taskId: input.taskId,
      });
    },
  });

  get tasksMarkedFailed(): Map<string, string> {
    const map = new Map<string, string>();
    for (const [taskId, row] of this.writer.tasks.entries()) {
      if (row.status === "failed" && row.failureKind !== null) {
        map.set(taskId, row.failureKind);
      }
    }
    return map;
  }

  appendEvent = async <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string): Promise<void> => {
    if (this.throwOnEventTypes.has(eventType)) {
      throw new Error(`event-append transport failure: ${eventType}`);
    }
    this.events.push({ eventType, payload: payload as Record<string, unknown>, taskId });
  };

  costCtx(): SubtaskCostContext {
    const recorder = {
      record: async () => {
        if (this.recorderThrows) {
          throw new Error("cost recorder DB INSERT failed (pg transport / RLS / schema)");
        }
        return undefined as never;
      },
    } as unknown as CostRecorder;
    return { recorder, runId: "run_1", specId: "spec_1", projectId: PROJECT, orgId: ORG };
  }
}

function run(h: GuardHarness): Promise<unknown> {
  return runDesignOracleLoopStage({
    pool: h.pool,
    writer: h.writer,
    costCtx: h.costCtx(),
    adapter: makeDesignOracle([
      { verificationMode: "static-surface-inspection", findings: [], summary: "inspected surfaces" },
    ]),
    client: h.pool,
    projectId: PROJECT,
    actor,
    actorRef: { kind: "operator" },
    runId: "run_1",
    workspacePath: "/ws",
    plannerTaskId: "task_plan",
    baselineSha: "a".repeat(40),
    appendEvent: h.appendEvent,
  });
}

function observedDesignOracleTaskId(h: GuardHarness): string {
  const started = h.events.find((e) => e.eventType === "task.started" && e.payload.taskKind === "designOracle");
  expect(started?.taskId).toBeDefined();
  return started!.taskId!;
}

describe("runDesignOracleLoopStage: WIDER finalize-guard contract (Codex critic #5)", () => {
  it("a cost-recorder throw after a successful oracle call ⇒ failureKind: cost_record_failed + one task.failed + re-throws", async () => {
    const h = new GuardHarness();
    h.recorderThrows = true;
    await expect(run(h)).rejects.toBeInstanceOf(Error);
    const taskId = observedDesignOracleTaskId(h);
    const failed = h.events.filter((e) => e.eventType === "task.failed" && e.taskId === taskId);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({ taskKind: "designOracle", failureKind: "cost_record_failed" });
    expect(typeof failed[0]!.payload.message).toBe("string");
    // The row UPDATE landed `failed` with the deterministic kind (NOT `crashed`, NOT stranded `running`).
    expect(h.tasksMarkedFailed.get(taskId)).toBe("cost_record_failed");
    // The single-finalize invariant: no clean-branch `task.completed` for the failed id.
    expect(h.events.filter((e) => e.eventType === "task.completed" && e.taskId === taskId)).toHaveLength(0);
  });

  it("a throw on the pre-terminal 'designOracle.verdict' event ⇒ failureKind: event_append_failed + one task.failed + re-throws", async () => {
    const h = new GuardHarness();
    h.throwOnEventTypes = new Set<EventName>(["designOracle.verdict"]);
    await expect(run(h)).rejects.toBeInstanceOf(Error);
    const taskId = observedDesignOracleTaskId(h);
    const failed = h.events.filter((e) => e.eventType === "task.failed" && e.taskId === taskId);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({ taskKind: "designOracle", failureKind: "event_append_failed" });
    expect(h.tasksMarkedFailed.get(taskId)).toBe("event_append_failed");
    expect(h.events.filter((e) => e.eventType === "task.completed" && e.taskId === taskId)).toHaveLength(0);
  });

  it("the clean path still lands one task.completed + no task.failed for the design-oracle task", async () => {
    const h = new GuardHarness();
    await expect(run(h)).resolves.toMatchObject({});
    const taskId = observedDesignOracleTaskId(h);
    expect(h.events.filter((e) => e.eventType === "task.failed" && e.taskId === taskId)).toHaveLength(0);
    expect(h.events.filter((e) => e.eventType === "task.completed" && e.taskId === taskId)).toHaveLength(1);
  });
});
