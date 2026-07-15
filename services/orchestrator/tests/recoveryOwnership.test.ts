// Recovery ownership: allowlists, system-scope settlement evidence, dual-coordinator parity.

import { afterEach, describe, expect, it } from "vitest";
import { setSystemPool, resetSystemPool } from "@tanren/db";
import type { ConflictRecoveryReceipt } from "../src/engine/contracts/conflictResolution.js";
import {
  findActiveOwnerRunForSpec,
  hasStructuralOwnedReceiptShape,
  isActiveOwnerRunStatus,
  isRecoverableSourceSpecStatus,
  loadSpecStatusForRecovery,
} from "../src/engine/merge/recoveryOwnership.js";
import { PgRecoveryEvidencePort } from "../src/engine/merge/recoveryEvidencePg.js";
import { EventEmittingMergeCoordinator } from "../src/engine/merge/coordinator.js";
import {
  InMemoryMergeQueueModel,
  RecordingMergeQueueEventEmitter,
  RecordingSpecEscalator,
  ScriptedMergeRunner,
} from "./conformance/fakes/inMemoryMergeQueue.js";
import { RecordingBatchGateReworkRouter } from "./conformance/fakes/inMemoryBatchChecker.js";
import { ScriptedRecoveryEvidencePort } from "./fixtures/scriptedRecoveryEvidence.js";
import { applyPrepareSpecForRecovery } from "../src/engine/worker/runStateLifecycleSql.js";
import type pg from "pg";

describe("hasStructuralOwnedReceiptShape — pre-check only", () => {
  const ownedEnqueued = (specId: string, runId = "run_r", taskId = "task_r"): ConflictRecoveryReceipt => ({
    kind: "planner_replan",
    specId,
    run: { kind: "enqueued", replanRunId: runId, plannerTaskId: taskId },
  });

  it("accepts matching non-empty enqueued shape", () => {
    expect(hasStructuralOwnedReceiptShape(ownedEnqueued("spec_a"), "spec_a")).toBe(true);
  });

  it("rejects wrong-spec and empty ids", () => {
    expect(hasStructuralOwnedReceiptShape(ownedEnqueued("spec_other"), "spec_a")).toBe(false);
    expect(hasStructuralOwnedReceiptShape(ownedEnqueued("spec_a", "", "task"), "spec_a")).toBe(false);
  });
});

describe("isRecoverableSourceSpecStatus — fail-closed allowlist", () => {
  it("allows only open / in_flight / review", () => {
    expect(isRecoverableSourceSpecStatus("open")).toBe(true);
    expect(isRecoverableSourceSpecStatus("in_flight")).toBe(true);
    expect(isRecoverableSourceSpecStatus("review")).toBe(true);
  });

  it("rejects terminal-blocked and unknown", () => {
    for (const s of ["merged", "halted", "cancelled", "needs_attention", "blocked", "unknown", ""]) {
      expect(isRecoverableSourceSpecStatus(s)).toBe(false);
    }
  });
});

describe("isActiveOwnerRunStatus — excludes halted", () => {
  it("allows queued/running/paused only", () => {
    expect(isActiveOwnerRunStatus("queued")).toBe(true);
    expect(isActiveOwnerRunStatus("running")).toBe(true);
    expect(isActiveOwnerRunStatus("paused")).toBe(true);
    expect(isActiveOwnerRunStatus("halted")).toBe(false);
  });
});

describe("applyPrepareSpecForRecovery — atomic allowlist", () => {
  it("writes steering+reopen only for allowlisted status; refuses terminal with zero mutation", async () => {
    const ops: string[] = [];
    let status = "merged";
    const client = {
      async query(sql: string, params?: unknown[]) {
        ops.push(String(sql).replaceAll(/\s+/gu, " ").trim());
        if (String(sql).includes("SELECT status") && String(sql).includes("FOR UPDATE")) {
          return { rows: [{ status }], rowCount: 1 };
        }
        if (String(sql).includes("UPDATE specs")) {
          status = String(params?.[2] ?? status);
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    const refused = await applyPrepareSpecForRecovery(client, {
      specId: "s1",
      orgId: "o1",
      steeringNote: "note",
    });
    expect(refused).toEqual({ prepared: false, reason: "not_recoverable", status: "merged" });
    expect(ops.some((o) => o.includes("UPDATE specs"))).toBe(false);

    status = "in_flight";
    const ok = await applyPrepareSpecForRecovery(client, {
      specId: "s1",
      orgId: "o1",
      steeringNote: "note",
    });
    expect(ok).toEqual({ prepared: true, fromStatus: "in_flight" });
    expect(ops.some((o) => o.includes("UPDATE specs") && o.includes("status = 'open'"))).toBe(true);
  });

  it("reopen-only prepare (no steering) still hardcodes open and writes zero steering", async () => {
    const ops: string[] = [];
    let status = "review";
    const client = {
      async query(sql: string, _params?: unknown[]) {
        ops.push(String(sql).replaceAll(/\s+/gu, " ").trim());
        if (String(sql).includes("SELECT status") && String(sql).includes("FOR UPDATE")) {
          return { rows: [{ status }], rowCount: 1 };
        }
        if (String(sql).includes("UPDATE specs")) {
          status = "open";
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    const ok = await applyPrepareSpecForRecovery(client, { specId: "s1", orgId: "o1" });
    expect(ok).toEqual({ prepared: true, fromStatus: "review" });
    expect(ops.some((o) => o.includes("operator steering"))).toBe(false);
    expect(ops.some((o) => o.includes("status = 'open'"))).toBe(true);
  });
});

/** Pool that records every SQL text (BEGIN / SET LOCAL / query / COMMIT). */
function scopeAwarePool(handlers: Array<{ match: (sql: string) => boolean; rows: unknown[] }>) {
  const ops: string[] = [];
  // eslint-disable-next-line @typescript-eslint/require-await
  const query = async (sql: string) => {
    const text = String(sql);
    ops.push(text.replaceAll(/\s+/gu, " ").trim());
    for (const h of handlers) {
      if (h.match(text)) return { rows: h.rows, rowCount: h.rows.length };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = {
    query,
    // eslint-disable-next-line @typescript-eslint/require-await
    connect: async () => ({ query, release: () => {} }),
    _ops: ops,
  };
  return pool as unknown as pg.Pool & { _ops: string[] };
}

describe("routing reads — runWithOrgScope (RLS-visible)", () => {
  it("findActiveOwnerRunForSpec emits BEGIN + SET LOCAL app.current_org_id + COMMIT", async () => {
    const pool = scopeAwarePool([
      {
        match: (s) => s.includes("FROM runs") && s.includes("queued"),
        rows: [{ run_id: "run_live", status: "running" }],
      },
    ]);
    const found = await findActiveOwnerRunForSpec(pool, "org_tenant", "spec_a");
    expect(found).toEqual({ runId: "run_live", status: "running" });
    expect(pool._ops[0]).toBe("BEGIN");
    expect(pool._ops.some((o) => o.includes("SET LOCAL app.current_org_id = 'org_tenant'"))).toBe(true);
    expect(pool._ops.at(-1)).toBe("COMMIT");
  });

  it("loadSpecStatusForRecovery fails closed when scope is omitted (zero rows under RLS)", async () => {
    const pool = scopeAwarePool([
      { match: (s) => s.includes("FROM specs") && s.includes("status"), rows: [{ status: "in_flight" }] },
    ]);
    const status = await loadSpecStatusForRecovery(pool, "org_tenant", "spec_a");
    expect(status).toBe("in_flight");
    expect(pool._ops.some((o) => o.includes("SET LOCAL app.current_org_id = 'org_tenant'"))).toBe(true);
    // Without SET LOCAL a production app-pool read would see zero — prove the GUC was set.
    expect(pool._ops.filter((o) => o.startsWith("BEGIN") || o.includes("SET LOCAL")).length).toBeGreaterThanOrEqual(2);
  });
});

describe("PgRecoveryEvidencePort — system-scope readback", () => {
  afterEach(() => {
    resetSystemPool();
  });

  it("uses system scope BEGIN/COMMIT (not unscoped raw app query)", async () => {
    const pool = scopeAwarePool([
      {
        match: (s) => s.includes("FROM runs") && s.includes("run_id"),
        rows: [{ run_id: "run_r", spec_id: "spec_a", status: "queued" }],
      },
      { match: (s) => s.includes("FROM tasks"), rows: [{ task_id: "task_r" }] },
    ]);
    setSystemPool(pool);
    const port = new PgRecoveryEvidencePort(pool);
    const evidence = await port.verifyOwnedReceipt({
      expectedSpecId: "spec_a",
      receipt: {
        kind: "planner_replan",
        specId: "spec_a",
        run: { kind: "enqueued", replanRunId: "run_r", plannerTaskId: "task_r" },
      },
    });
    expect(evidence?.runId).toBe("run_r");
    expect(pool._ops).toEqual(expect.arrayContaining(["BEGIN", "COMMIT"]));
    // System scope does NOT set app.current_org_id (BYPASSRLS path).
    expect(pool._ops.some((o) => o.includes("app.current_org_id"))).toBe(false);
  });

  it("rejects halted run status", async () => {
    const pool = scopeAwarePool([
      {
        match: (s) => s.includes("FROM runs"),
        rows: [{ run_id: "run_r", spec_id: "spec_a", status: "halted" }],
      },
    ]);
    setSystemPool(pool);
    const port = new PgRecoveryEvidencePort(pool);
    expect(
      await port.verifyOwnedReceipt({
        expectedSpecId: "spec_a",
        receipt: {
          kind: "planner_replan",
          specId: "spec_a",
          run: { kind: "already_running", runId: "run_r" },
        },
      }),
    ).toBeUndefined();
  });
});

describe("EventEmittingMergeCoordinator — evidence port required", () => {
  const PROJECT = "project_parity";

  it("parks conflict without RecoveryEvidencePort", async () => {
    const queue = new InMemoryMergeQueueModel();
    const runner = new ScriptedMergeRunner();
    const events = new RecordingMergeQueueEventEmitter();
    const escalator = new RecordingSpecEscalator();
    queue.seed({ runId: "run_a", specId: "spec_a", dependsOn: [], priority: "tbd" });
    runner.script("run_a", {
      kind: "conflict",
      message: "typed receipt",
      recovery: {
        kind: "planner_replan",
        specId: "spec_a",
        run: { kind: "enqueued", replanRunId: "r", plannerTaskId: "t" },
      },
    });
    const coordinator = new EventEmittingMergeCoordinator({ queue, runner, events, escalator });
    await coordinator.coordinate(PROJECT);
    expect(queue.dequeueReasonOf("run_a")).toBe("needs_attention");
  });

  it("dequeues conflict when evidence port proves the active owner run", async () => {
    const queue = new InMemoryMergeQueueModel();
    const runner = new ScriptedMergeRunner();
    const events = new RecordingMergeQueueEventEmitter();
    const escalator = new RecordingSpecEscalator();
    const evidence = new ScriptedRecoveryEvidencePort();
    evidence.seedEnqueued("spec_a", "run_replan", "task_replan", "queued");
    queue.seed({ runId: "run_a", specId: "spec_a", dependsOn: [], priority: "tbd" });
    runner.script("run_a", {
      kind: "conflict",
      message: "owned",
      recovery: {
        kind: "planner_replan",
        specId: "spec_a",
        run: { kind: "enqueued", replanRunId: "run_replan", plannerTaskId: "task_replan" },
      },
    });
    const coordinator = new EventEmittingMergeCoordinator({
      queue,
      runner,
      events,
      escalator,
      recoveryEvidence: evidence,
    });
    await coordinator.coordinate(PROJECT);
    expect(queue.dequeueReasonOf("run_a")).toBe("conflict");
  });

  it("routes failed drive to writer rework when gateRework + evidence are wired", async () => {
    const queue = new InMemoryMergeQueueModel();
    const runner = new ScriptedMergeRunner();
    const events = new RecordingMergeQueueEventEmitter();
    const escalator = new RecordingSpecEscalator();
    const gateRework = new RecordingBatchGateReworkRouter();
    const evidence = new ScriptedRecoveryEvidencePort();
    evidence.seedEnqueued("spec_a", "run_rework_spec_a", "task_rework_spec_a", "queued");
    queue.seed({ runId: "run_a", specId: "spec_a", dependsOn: [], priority: "tbd" });
    runner.script("run_a", { kind: "failed", message: "fresh pre_merge failed" });
    const coordinator = new EventEmittingMergeCoordinator({
      queue,
      runner,
      events,
      escalator,
      gateRework,
      recoveryEvidence: evidence,
    });
    await coordinator.coordinate(PROJECT);
    expect(queue.dequeueReasonOf("run_a")).toBe("superseded");
  });

  it("FAIL-CLOSED: failed drive with writer receipt but no evidence port parks", async () => {
    const queue = new InMemoryMergeQueueModel();
    const runner = new ScriptedMergeRunner();
    const events = new RecordingMergeQueueEventEmitter();
    const escalator = new RecordingSpecEscalator();
    const gateRework = new RecordingBatchGateReworkRouter();
    queue.seed({ runId: "run_a", specId: "spec_a", dependsOn: [], priority: "tbd" });
    runner.script("run_a", { kind: "failed", message: "fresh pre_merge failed" });
    const coordinator = new EventEmittingMergeCoordinator({
      queue,
      runner,
      events,
      escalator,
      gateRework,
    });
    await coordinator.coordinate(PROJECT);
    expect(queue.dequeueReasonOf("run_a")).toBe("needs_attention");
    expect(escalator.escalations[0]?.message).toMatch(/no RecoveryEvidencePort/u);
  });
});
