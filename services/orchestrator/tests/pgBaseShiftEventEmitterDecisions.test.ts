// #928 production-faithful pin: PgBaseShiftEventEmitter must append every valid
// public RebaseDecision through runStateWriter.append (eventStore path).
// On d33 the emitter intentionally dropped `held`, and the coordinator collapsed
// terminal_noop / parking_failed / parking_required into that dropped token — so
// no integration.rebase event, metric, or UI evidence existed. This test fails
// on that hole by proving the three exact decisions persist as payload.decision.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { allowRuntimePoolAsSystemForTests, resetSystemPool, setSystemPool } from "@tanren/db";
import type { RunStateWriter } from "../src/engine/contracts/runStateWriter.js";
import { PgBaseShiftEventEmitter } from "../src/engine/dag/baseShiftCoordinatorPg.js";
import type { RebaseDecision } from "../src/engine/dag/baseShiftPorts.js";
import type { AppendEventInput } from "../src/engine/eventStore.js";
import { RebaseDecisionValues } from "../src/engine/insights/integration/types.js";

interface RecordedQuery {
  text: string;
  params: unknown[];
}

class RecordingPool {
  readonly queries: RecordedQuery[] = [];
  scriptedProjectOrgId: string | null = "org_emit";

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

class RecordingWriter implements Pick<RunStateWriter, "append"> {
  readonly appends: AppendEventInput[] = [];
  async append(input: AppendEventInput): Promise<void> {
    this.appends.push(input);
  }
}

function poolAs(pool: RecordingPool): pg.Pool {
  return pool as unknown as pg.Pool;
}
function writerAs(writer: RecordingWriter): RunStateWriter {
  return writer as unknown as RunStateWriter;
}

const EXACT_RECOVERY: readonly RebaseDecision[] = ["terminal_noop", "parking_failed", "parking_required"];

describe("PgBaseShiftEventEmitter — every public RebaseDecision persists (#928)", () => {
  let pool: RecordingPool;
  let writer: RecordingWriter;
  let emitter: PgBaseShiftEventEmitter;

  beforeEach(() => {
    allowRuntimePoolAsSystemForTests();
    pool = new RecordingPool();
    writer = new RecordingWriter();
    setSystemPool(poolAs(pool));
    emitter = new PgBaseShiftEventEmitter(poolAs(pool), writerAs(writer));
  });

  afterEach(() => {
    resetSystemPool();
  });

  it("HOSTILE production hole: terminal_noop + parking_failed + parking_required each append once", async () => {
    for (const decision of EXACT_RECOVERY) {
      await emitter.emitRebase({
        projectId: "proj_1",
        specId: "spec_1",
        runId: `run_${decision}`,
        branch: "tanren/run",
        newBaseSha: "base",
        headSha: "head",
        rebaseConflicted: true,
        decision,
      });
    }
    // d33 drop: held-suppression swallowed these when collapsed to held — assert exact tokens.
    expect(writer.appends).toHaveLength(3);
    const decisions = writer.appends.map((a) => {
      expect(a.eventType).toBe("integration.rebase");
      const payload = a.payload as { decision: string; runId: string; sameRunId: boolean };
      expect(payload.sameRunId).toBe(true);
      return payload.decision;
    });
    expect(decisions).toEqual(["terminal_noop", "parking_failed", "parking_required"]);
    // No public `held` token may appear on the event plane.
    expect(decisions).not.toContain("held");
  });

  it("every RebaseDecision value appends with no silent suppression", async () => {
    for (const decision of RebaseDecisionValues) {
      await emitter.emitRebase({
        projectId: "proj_1",
        specId: "spec_1",
        runId: `run_${decision}`,
        branch: "tanren/run",
        newBaseSha: "base",
        headSha: "head",
        rebaseConflicted: false,
        decision,
      });
    }
    expect(writer.appends).toHaveLength(RebaseDecisionValues.length);
    const persisted = writer.appends.map((a) => (a.payload as { decision: string }).decision);
    expect(persisted).toEqual([...RebaseDecisionValues]);
    expect(persisted).not.toContain("held");
  });

  it("missing project org rejects loudly and never appends (#audit)", async () => {
    pool.scriptedProjectOrgId = null;
    await expect(
      emitter.emitRebase({
        projectId: "proj_no_org",
        specId: "spec_1",
        runId: "run_reject",
        branch: "tanren/run",
        newBaseSha: "base",
        headSha: "head",
        rebaseConflicted: false,
        decision: "rebased_clean",
      }),
    ).rejects.toThrow("has no org for the base-shift integration.rebase emit");
    // A supposedly successful base-shift must never lose its integration.rebase evidence:
    // the silent-return regression would have skipped the append entirely.
    expect(writer.appends).toHaveLength(0);
  });
});
