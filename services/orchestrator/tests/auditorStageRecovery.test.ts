// An auditor SCHEMA-PARSE MISS must be RECOVERABLE, not a permanent run-`failed`
// dead-end. SPEC-LOOP REDESIGN: when the auditor's model emits output that fails the
// AuditAnswer schema parse, `runAuditorStage` surfaces it as a synthetic P0 FINDING
// (the loop's triage routes a fix-in-spec task) rather than letting the throw escape to
// the workflow catch-all that lands the run `failed`. Fail-closed is preserved: no
// `auditor.verdict` is written, so the land gate's synthetic-P0 still blocks any merge.
// A NON-schema error (real infra/timeout) still propagates — only the schema miss recovers.

import { describe, expect, it } from "vitest";
import type { EventName, EventPayload } from "../src/engine/events/index.js";
import type { CostRecorder } from "../src/engine/costs/index.js";
import type { AuditAnswer } from "../src/engine/answerers/schemas/index.js";
import type { AnswererAdapter } from "../src/engine/providers/types.js";
import { AnswererSchemaValidationError } from "../src/engine/providers/codex.js";
import { runAuditorStage, type AuditorStageInput } from "../src/engine/workflow/subtaskStages.js";
import type { SubtaskCostContext } from "../src/engine/workflow/subtaskCost.js";
import { buildPlan } from "./helpers/plannerLoopHelpers.js";
import { InMemoryRunStateWriter } from "./fixtures/inMemoryRunStateWriter.js";

// A compact recording harness: just the appendEvent + pg-shaped query stub + costCtx the
// auditor stage drives (a focused subset of the StageHarness in subtaskStages.test.ts).
class AuditHarness {
  readonly events: { eventType: EventName; payload: Record<string, unknown> }[] = [];
  // Audit finding H3 sweep: the auditor stage's terminal seam REQUIRES a writer
  // (the fallback split-write arm is gone). The fixture forwards atomic events
  // back into `events` so the existing pin assertions keep holding.
  readonly writer = new InMemoryRunStateWriter({
    forwardAppend: async (input) => {
      this.events.push({
        eventType: input.eventType as EventName,
        payload: input.payload as Record<string, unknown>,
      });
    },
  });
  get taskOutcomes(): Map<string, string> {
    const map = new Map<string, string>();
    for (const [taskId, row] of this.writer.tasks.entries()) {
      if (row.failureKind !== null) {
        map.set(taskId, row.failureKind);
      } else if (row.outcome !== null) {
        map.set(taskId, row.outcome);
      }
    }
    return map;
  }

  appendEvent = async <N extends EventName>(eventType: N, payload: EventPayload<N>): Promise<void> => {
    this.events.push({ eventType, payload: payload as Record<string, unknown> });
  };

  query = async (_sql: string, _params: ReadonlyArray<unknown> = []): Promise<{ rows: never[]; rowCount: number }> => {
    return { rows: [], rowCount: 1 };
  };

  costCtx(): SubtaskCostContext {
    const recorder = { record: async () => undefined as never } as unknown as CostRecorder;
    return { recorder, runId: "run_1", specId: "spec_1", projectId: "proj_1" };
  }

  names(): EventName[] {
    return this.events.map((e) => e.eventType);
  }

  find(eventType: EventName): { payload: Record<string, unknown> } | undefined {
    return this.events.find((e) => e.eventType === eventType);
  }
}

function auditorArgs(h: AuditHarness, adapter: AnswererAdapter<AuditAnswer>): AuditorStageInput {
  return {
    pool: { query: h.query },
    writer: h.writer,
    costCtx: h.costCtx(),
    adapter,
    runId: "run_1",
    workspacePath: "/ws",
    plannerTaskId: "task_plan",
    plan: buildPlan([{ title: "T1", intent: "i", behaviorIds: ["B1"] }]),
    baseSha: "a".repeat(40),
    specTitle: "S",
    specDescription: "D",
    acceptanceCriteria: ["AC1"],
    timeoutMs: 1000,
    appendEvent: h.appendEvent,
  };
}

function throwingAuditor(error: unknown): AnswererAdapter<AuditAnswer> {
  return {
    kind: "answerer",
    cli: "fake",
    authRef: "secret://fake",
    runAnswerer: () => {
      throw error;
    },
  };
}

describe("runAuditorStage — auditor schema-miss recovery", () => {
  it("RECOVERS from a schema-parse miss: returns a synthetic P0 finding, NEVER dead-ends the run", async () => {
    const h = new AuditHarness();
    const adapter = throwingAuditor(
      new AnswererSchemaValidationError("AuditAnswer", "findings: expected array, received undefined"),
    );
    const { findings, auditorTaskId } = await runAuditorStage(auditorArgs(h, adapter));

    // NOT a throw: a synthetic P0 FINDING the loop's triage routes to a fix-in-spec task.
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "P0", id: "auditor-schema-miss" });
    // Fail-closed preserved: NO auditor.verdict was written (the durable record stays
    // un-audited, so the land gate's synthetic-P0 still blocks the merge).
    expect(h.names()).not.toContain("auditor.verdict");
    // The audit task is marked failed with a distinct kind (not dangling, not passed).
    expect(h.taskOutcomes.get(auditorTaskId)).toBe("auditor_schema_invalid");
    // Audit-trail integrity (critic-arc R1 #5 fix): the EVENT must match the ROW
    // state. markTaskFailed flipped the row to `failed`; the loud event is now
    // `task.failed`, NOT `task.completed`. The prior contract emitted
    // `task.completed` here, which directly contradicted the task table.
    expect(h.find("task.completed")).toBeUndefined();
    const taskFailed = h.find("task.failed")!;
    expect(taskFailed.payload.taskKind).toBe("audit");
    expect((taskFailed.payload as { failureKind?: string }).failureKind).toBe("auditor_schema_invalid");
  });

  it("does NOT swallow a non-schema auditor error (a real infra/timeout throw still propagates)", async () => {
    const h = new AuditHarness();
    const adapter = throwingAuditor(new Error("ssh transport died"));
    await expect(runAuditorStage(auditorArgs(h, adapter))).rejects.toThrow(/ssh transport died/u);
    // A genuine error is NOT miscast as a recoverable loop-back.
    expect(h.names()).not.toContain("auditor.rejected");
  });
});
