// Stage-WIRING test for the native entity-risk oracle (§3.1): drives
// runCheckerStage and pins the deterministic `checker.entity_risk` event emitted
// BEFORE the LLM judgement. The classifier/posture themselves are exhaustively
// unit-tested in entityRiskTaxonomy.test.ts + checkerRiskPosture.test.ts; this
// file owns the SEAM — that the stage derives the signal, classifies a supplied
// entity map, and surfaces the unexpected (loud) producer-errored case. A small
// local harness keeps this self-contained (and subtaskStages.test.ts under cap).
import { describe, expect, it } from "vitest";
import type { CostRecorder } from "../src/engine/costs/index.js";
import type { EventName, EventPayload } from "../src/engine/events/index.js";
import type { SubtaskCostContext } from "../src/engine/workflow/subtaskCost.js";
import { runCheckerStage } from "../src/engine/workflow/subtaskStages.js";
import { completeCheck, makeChecker } from "./helpers/plannerLoopHelpers.js";

interface RecordedEvent {
  eventType: EventName;
  payload: Record<string, unknown>;
}

class CheckerHarness {
  readonly events: RecordedEvent[] = [];

  appendEvent = async <N extends EventName>(eventType: N, payload: EventPayload<N>): Promise<void> => {
    this.events.push({ eventType, payload: payload as Record<string, unknown> });
  };

  query = async (): Promise<{ rows: never[]; rowCount: number }> => ({ rows: [], rowCount: 1 });

  costCtx(): SubtaskCostContext {
    const recorder = { record: async () => undefined as never } as unknown as CostRecorder;
    return { recorder, runId: "run_1", specId: "spec_1", projectId: "proj_1" };
  }

  riskPayload(): Record<string, unknown> {
    const found = this.events.find((e) => e.eventType === "checker.entity_risk");
    if (found === undefined) throw new Error("no checker.entity_risk event emitted");
    return found.payload;
  }
}

function checkerArgs(h: CheckerHarness) {
  return {
    pool: { query: h.query },
    costCtx: h.costCtx(),
    adapter: makeChecker([completeCheck]),
    runId: "run_1",
    workspacePath: "/ws",
    writeTaskId: "task_write",
    checkerTaskId: "task_check",
    subtask: { index: 0, title: "T", intent: "i", behaviorIds: ["B1"] },
    writerResult: { diff: "d", commits: [], exitReason: "completed" as const },
    specTitle: "S",
    specDescription: "D",
    acceptanceCriteria: ["AC1"],
    timeoutMs: 1000,
    appendEvent: h.appendEvent,
  };
}

describe("runCheckerStage — entity-risk oracle wiring (§3.1)", () => {
  it("emits the unknown/no-producer fallback when no entity map is supplied (graceful default)", async () => {
    const h = new CheckerHarness();
    await runCheckerStage(checkerArgs(h));
    expect(h.riskPayload()).toMatchObject({
      riskClass: "unknown",
      provenance: "no-producer",
      unexpectedFailure: false,
      scrutiny: "standard",
      subtaskIndex: 0,
    });
  });

  it("classifies a supplied entity map and emits the real risk class + posture", async () => {
    const h = new CheckerHarness();
    await runCheckerStage({
      ...checkerArgs(h),
      entityChangeMap: {
        entities: [{ kind: "modified", nature: "structural", visibility: "public", signatureChanged: true }],
      },
    });
    expect(h.riskPayload()).toMatchObject({
      riskClass: "public-api-signature",
      provenance: "classified",
      scrutiny: "maximal",
      counts: { publicSignature: 1 },
    });
  });

  it("flags unexpectedFailure on a producer-errored map (observable per no-silent-fallback)", async () => {
    const h = new CheckerHarness();
    await runCheckerStage({ ...checkerArgs(h), entityMapUnavailable: "producer-errored" });
    expect(h.riskPayload()).toMatchObject({
      riskClass: "unknown",
      provenance: "producer-errored",
      unexpectedFailure: true,
    });
  });
});
