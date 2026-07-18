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
import { InMemoryRunStateWriter } from "./fixtures/inMemoryRunStateWriter.js";

interface RecordedEvent {
  eventType: EventName;
  payload: Record<string, unknown>;
}

class CheckerHarness {
  readonly events: RecordedEvent[] = [];
  // Audit finding H3 sweep: writer REQUIRED at the checker's atomic terminal seam.
  readonly writer = new InMemoryRunStateWriter({
    forwardAppend: async (input) => {
      this.events.push({
        eventType: input.eventType as EventName,
        payload: input.payload as Record<string, unknown>,
      });
    },
  });

  appendEvent = async <N extends EventName>(eventType: N, payload: EventPayload<N>): Promise<void> => {
    this.events.push({ eventType, payload: payload as Record<string, unknown> });
  };

  query = async (): Promise<{ rows: never[]; rowCount: number }> => ({ rows: [], rowCount: 1 });

  costCtx(): SubtaskCostContext {
    const recorder = { record: async () => undefined as never } as unknown as CostRecorder;
    return { recorder, runId: "run_1", specId: "spec_1", projectId: "proj_1", orgId: "org_1" };
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
    writer: h.writer,
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

  it("classifies from the HOST-SIDE PRODUCER's map (the production wiring — real entity data, not the default unknown)", async () => {
    const h = new CheckerHarness();
    let producerBaseline: string | undefined;
    await runCheckerStage({
      ...checkerArgs(h),
      baseSha: "base_sha_xyz",
      entityRiskProducer: async (baselineSha) => {
        producerBaseline = baselineSha;
        return {
          map: {
            entities: [
              { kind: "modified", nature: "structural", visibility: "internal" },
              { kind: "deleted", nature: "structural", visibility: "internal" },
            ],
          },
        };
      },
    });
    // The producer is invoked over the checker's diff base (the same baselineSha
    // the agent self-inspects against), and its map drives the classification.
    expect(producerBaseline).toBe("base_sha_xyz");
    expect(h.riskPayload()).toMatchObject({
      riskClass: "structural",
      provenance: "classified",
      scrutiny: "heightened",
      counts: { deletedOrRenamed: 1 },
    });
  });

  it("uses the producer's unavailability (producer-errored) — the loud no-silent-fallback path", async () => {
    const h = new CheckerHarness();
    await runCheckerStage({
      ...checkerArgs(h),
      entityRiskProducer: async () => ({ unavailable: "producer-errored" }),
    });
    expect(h.riskPayload()).toMatchObject({
      riskClass: "unknown",
      provenance: "producer-errored",
      unexpectedFailure: true,
    });
  });

  it("degrades to producer-errored when the producer THROWS (contracted never to, so a throw is the unexpected case)", async () => {
    const h = new CheckerHarness();
    await runCheckerStage({
      ...checkerArgs(h),
      entityRiskProducer: async () => {
        throw new Error("unexpected boom");
      },
    });
    expect(h.riskPayload()).toMatchObject({
      riskClass: "unknown",
      provenance: "producer-errored",
      unexpectedFailure: true,
    });
  });
});
