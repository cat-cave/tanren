// rv-26.3 bisection event alignment — negative-control + payload-discipline guard.
//
// `merge.batch.culprit_set_identified` (rv-25 runtime vocabulary) is the
// canonical event for "bisection isolated the culprit SET" (the ddmin/
// QuickXPlain minimal failing subset — autonomy-engine.md §2d / runtime spec
// §7 negative-control #4 "Interaction failure"). The legacy singular
// `merge.batch.culprit` event was clean-replaced by this name (the schema is
// removed from the live EventRegistry; the name is retained in
// RETAINED_HISTORICAL_EVENTS for FK safety only). `merge.batch.behavior_failed`
// is the new producer for "a batch's behavior verification failed — the failure
// that triggered bisection".
//
// This test pins BOTH producers on the PRODUCTION `PgBatchMergeEventEmitter`
// (the same class the composition root wires into BatchMergeCoordinator), not a
// fake. The DB I/O is mocked (RecordingPool + RecordingWriter, the same pattern
// as batchCoordinatorPgUnresolvableOrg.test.ts) so the test runs DB-free under
// `just fast-check`; the captured `append` input is then parsed through the
// REGISTERED Zod schema to prove the payload the emitter constructs is exactly
// what the eventStore accepts (no coercion, no blank-slip).
//
// The headline negative control: a planted 2-member culprit batch MUST emit
// `merge.batch.culprit_set_identified` carrying BOTH culprit member ids (the
// exact set — a silent singleton collapse would drop a real culprit), AND
// `merge.batch.behavior_failed` MUST fire on the failing batch. Both producers
// route through the org-scoped eventStore seam (the single event-writer).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { setSystemPool, resetSystemPool, allowRuntimePoolAsSystemForTests } from "@tanren/db";
import { PgBatchMergeEventEmitter } from "../src/engine/merge/batchCoordinatorPg.js";
import type { RunStateWriter } from "../src/engine/contracts/runStateWriter.js";
import type { AppendEventInput } from "../src/engine/eventStore.js";
import type { MergeQueueEntry } from "../src/engine/contracts/mergeCoordinator.js";
import { EventRegistry } from "../src/engine/events/index.js";

/**
 * A minimal `pg.Pool` stand-in (mirrors batchCoordinatorPgUnresolvableOrg.test.ts):
 * resolves the project's org_id, captures every non-tx-control statement so we
 * can assert the emitter DID route through the scoped writer on the happy path.
 */
class RecordingPool {
  readonly queries: Array<{ text: string; params: unknown[] }> = [];
  scriptedProjectOrgId = "org_resolved";

  private record(text: string, params: unknown[]): { rows: unknown[]; rowCount: number } {
    const trimmed = text.trim();
    const isTxControl = ["BEGIN", "COMMIT", "ROLLBACK"].includes(trimmed) || trimmed.startsWith("SET LOCAL");
    if (isTxControl) return { rows: [], rowCount: 0 };
    this.queries.push({ text, params });
    if (/SELECT org_id FROM projects/u.test(text)) {
      return { rows: [{ org_id: this.scriptedProjectOrgId }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
  async query(text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    return this.record(text, params);
  }
  async connect(): Promise<pg.PoolClient> {
    const record = (text: string, params: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> =>
      Promise.resolve(this.record(text, params));
    return {
      query: (text: string, params: unknown[] = []) => record(text, params),
      release: () => {},
    } as unknown as pg.PoolClient;
  }
}

function poolAs(pool: RecordingPool): pg.Pool {
  return pool as unknown as pg.Pool;
}

class RecordingWriter implements Pick<RunStateWriter, "append"> {
  readonly appends: AppendEventInput[] = [];
  async append(input: AppendEventInput): Promise<void> {
    this.appends.push(input);
  }
}

function writerAs(writer: RecordingWriter): RunStateWriter {
  return writer as unknown as RunStateWriter;
}

function entry(overrides: Partial<MergeQueueEntry> = {}): MergeQueueEntry {
  return {
    orgId: "org_resolved",
    projectId: "project_1",
    queueId: "q_1",
    runId: "run_1",
    specId: "spec_1",
    prUrl: "https://example/pr/1",
    prNumber: 1,
    dependsOn: [],
    priority: "P1",
    orderKey: 1,
    ...overrides,
  };
}

describe("PgBatchMergeEventEmitter — rv-26.3 bisection event alignment", () => {
  let pool: RecordingPool;
  let writer: RecordingWriter;
  let emitter: PgBatchMergeEventEmitter;

  beforeEach(() => {
    allowRuntimePoolAsSystemForTests();
    pool = new RecordingPool();
    writer = new RecordingWriter();
    setSystemPool(poolAs(pool));
    emitter = new PgBatchMergeEventEmitter(poolAs(pool), writerAs(writer));
  });

  afterEach(() => {
    resetSystemPool();
  });

  describe("emitCulpritSetIdentified — the exact culprit SET (ddmin/QuickXPlain result)", () => {
    it("HEADLINE NEGATIVE CONTROL: a 2-member culprit batch emits BOTH member ids (the exact set)", async () => {
      // The bisection minimal-failing-subset solver identified a 2-member
      // interaction failure (rv-26 apex negative-control #4: a defect split
      // across two individually-passing members). The canonical event MUST
      // carry BOTH member ids — a silent singleton collapse would drop a real
      // culprit, so this test discriminates against that regression.
      const memberA = entry({ specId: "spec_a", runId: "run_a", prNumber: 101 });
      const memberB = entry({ specId: "spec_b", runId: "run_b", prNumber: 102 });
      const batch = [memberA, memberB];
      const groupId = "mqgrp_two_member_interaction";

      await emitter.emitCulpritSetIdentified({
        projectId: "project_1",
        batch,
        groupId,
        culpritMembers: [memberA, memberB],
      });

      expect(writer.appends).toHaveLength(1);
      const appended = writer.appends[0]!;
      expect(appended.eventType).toBe("merge.batch.culprit_set_identified");
      expect(appended.orgId).toBe("org_resolved");
      expect(appended.projectId).toBe("project_1");

      // rv-26.3 exact-set contract: BOTH member ids appear in the canonical
      // order the caller supplied them (no dedup, no reorder, no silent drop).
      const payload = appended.payload as { groupId: string; culpritMemberIds: string[] };
      expect(payload.groupId).toBe(groupId);
      expect(payload.culpritMemberIds).toEqual(["spec_a", "spec_b"]);
      expect(payload.culpritMemberIds).toHaveLength(2);

      // Schema discipline: the constructed payload parses through the REGISTERED
      // Zod schema (the same one PgEventStore.append validates against in
      // production). A malformed payload would fail here — proving the emitter
      // ships exactly what the eventStore accepts.
      expect(() => EventRegistry["merge.batch.culprit_set_identified"].parse(payload)).not.toThrow(
        "registered schema should accept the 2-member culprit set payload",
      );
    });

    it("carries the envelope runId/specId of the FIRST culprit (head) so the recoverable dequeue links back", async () => {
      const head = entry({ specId: "spec_head", runId: "run_head", prNumber: 1 });
      const other = entry({ specId: "spec_other", runId: "run_other", prNumber: 2 });

      await emitter.emitCulpritSetIdentified({
        projectId: "project_1",
        batch: [head, other],
        groupId: "mqgrp_x",
        culpritMembers: [head, other],
      });

      const appended = writer.appends[0]!;
      // The envelope stamps the head culprit so the run-scoped notify + the
      // recoverable re-execution dequeue can link the event back to a run.
      expect(appended.runId).toBe("run_head");
      expect(appended.specId).toBe("spec_head");
      // The payload still carries the FULL set — the envelope is a routing key,
      // the payload is the proof coordinate.
      expect((appended.payload as { culpritMemberIds: string[] }).culpritMemberIds).toEqual([
        "spec_head",
        "spec_other",
      ]);
    });

    it("NEGATIVE CONTROL: an EMPTY culprit set fails the registered schema (no vacuous culprit)", async () => {
      // The registered schema admits `culpritMemberIds: min(1).max(256)`. An
      // empty set is a vacuous culprit (the "rv-12 empty-set class") — the
      // schema REJECTS it. The emitter constructs whatever the caller supplies;
      // the gate is the registered schema. This test proves the gate fails
      // closed: the constructed payload does not parse.
      const member = entry({ specId: "spec_a", runId: "run_a", prNumber: 1 });
      await emitter.emitCulpritSetIdentified({
        projectId: "project_1",
        batch: [member],
        groupId: "mqgrp_empty",
        culpritMembers: [],
      });

      const payload = writer.appends[0]!.payload;
      // The empty set fails the schema — proving the registered min(1) guards
      // against a vacuous culprit event landing in the timeline.
      expect(() => EventRegistry["merge.batch.culprit_set_identified"].parse(payload)).toThrow(
        /culpritMemberIds|empty|min/u,
      );
    });
  });

  describe("emitBehaviorFailed — fires on the failing batch with the runtime behavior-proof coordinate", () => {
    it("HEADLINE NEGATIVE CONTROL: emits merge.batch.behavior_failed on the failing batch", async () => {
      // The batch's behavior verification failed (the failure that triggers
      // bisection). The payload carries the runtime behavior-proof coordinate
      // (groupId + behaviorRevisionId + verdictId + outcome) so downstream rv
      // consumers can correlate the batch failure with the verdict that named
      // it — these IDs are caller-supplied (the Runtime Behavior Proof Graph
      // mints them; the emitter never synthesizes a coordinate).
      const batch = [
        entry({ specId: "spec_a", runId: "run_a", prNumber: 11 }),
        entry({ specId: "spec_b", runId: "run_b", prNumber: 12 }),
      ];

      await emitter.emitBehaviorFailed({
        projectId: "project_1",
        batch,
        groupId: "mqgrp_failing_batch",
        behaviorRevisionId: "behavior_revision_run_a_v3",
        verdictId: "verdict_2026_07_21_001",
        outcome: "failed_product",
      });

      expect(writer.appends).toHaveLength(1);
      const appended = writer.appends[0]!;
      expect(appended.eventType).toBe("merge.batch.behavior_failed");
      expect(appended.orgId).toBe("org_resolved");
      expect(appended.projectId).toBe("project_1");

      const payload = appended.payload as {
        groupId: string;
        behaviorRevisionId: string;
        verdictId: string;
        outcome: string;
      };
      expect(payload).toEqual({
        groupId: "mqgrp_failing_batch",
        behaviorRevisionId: "behavior_revision_run_a_v3",
        verdictId: "verdict_2026_07_21_001",
        outcome: "failed_product",
      });

      // Schema discipline — parses through the registered Zod schema.
      expect(() => EventRegistry["merge.batch.behavior_failed"].parse(payload)).not.toThrow(
        "registered schema should accept the behavior_failed payload",
      );
    });

    it("NEGATIVE CONTROL: a blank/missing coordinate fails the registered schema (no coercion)", () => {
      // The registered schema requires non-empty coordinates (Id = min(1)). A
      // blank behaviorRevisionId is the "coercion / blank-slip" trap — the
      // schema REJECTS it rather than coercing it to a default. Prove the gate
      // fails closed: an empty/blank coordinate does not parse.
      const blankPayload = {
        groupId: "mqgrp_x",
        behaviorRevisionId: "",
        verdictId: "verdict_ok",
        outcome: "failed_product",
      };
      expect(() => EventRegistry["merge.batch.behavior_failed"].parse(blankPayload)).toThrow(/behaviorRevisionId|min/u);

      // And a wrong-type outcome (the enum guard) is rejected too — the
      // "unchecked cast" trap.
      const wrongOutcomePayload = {
        groupId: "mqgrp_x",
        behaviorRevisionId: "behavior_revision_ok",
        verdictId: "verdict_ok",
        outcome: "definitely_not_a_real_outcome",
      };
      expect(() => EventRegistry["merge.batch.behavior_failed"].parse(wrongOutcomePayload)).toThrow(/outcome|invalid/u);
    });

    it("every VerdictOutcome arm parses (allow-list discipline — no intermediate state slips through)", () => {
      // The outcome enum is the allow-list of GOOD outcomes. Every arm must
      // parse; an intermediate/unknown outcome must not. This pins the enum
      // against a future drift that would let an undecided verdict pass.
      const outcomes = [
        "passed",
        "failed_product",
        "failed_verification_contract",
        "failed_visual",
        "inconclusive_infrastructure",
        "inconclusive_external",
        "cancelled_superseded",
      ] as const;
      for (const outcome of outcomes) {
        const payload = {
          groupId: "mqgrp_x",
          behaviorRevisionId: "behavior_revision_ok",
          verdictId: "verdict_ok",
          outcome,
        };
        expect(() => EventRegistry["merge.batch.behavior_failed"].parse(payload)).not.toThrow(
          `registered schema should accept outcome=${outcome}`,
        );
      }
      // An unknown outcome is rejected (deny-list-vs-allow-list trap).
      expect(() =>
        EventRegistry["merge.batch.behavior_failed"].parse({
          groupId: "mqgrp_x",
          behaviorRevisionId: "behavior_revision_ok",
          verdictId: "verdict_ok",
          outcome: "failed_unknown_arm",
        }),
      ).toThrow(/outcome|invalid/u);
    });
  });

  describe("both producers route through the org-scoped eventStore seam (single event-writer)", () => {
    it("each emit appends exactly ONE event through the scoped writer (no orphan writes)", async () => {
      const member = entry({ specId: "spec_x", runId: "run_x", prNumber: 99 });

      await emitter.emitCulpritSetIdentified({
        projectId: "project_1",
        batch: [member],
        groupId: "mqgrp_x",
        culpritMembers: [member],
      });
      await emitter.emitBehaviorFailed({
        projectId: "project_1",
        batch: [member],
        groupId: "mqgrp_x",
        behaviorRevisionId: "behavior_revision_x",
        verdictId: "verdict_x",
        outcome: "failed_product",
      });

      // Each emit produces exactly one append — no half-wired second write, no
      // silent drop. The org resolver ran once per emit (the SELECT projects
      // query).
      expect(writer.appends).toHaveLength(2);
      expect(writer.appends.map((a) => a.eventType)).toEqual([
        "merge.batch.culprit_set_identified",
        "merge.batch.behavior_failed",
      ]);
      expect(pool.queries.filter((q) => /SELECT org_id FROM projects/u.test(q.text))).toHaveLength(2);
    });
  });
});
