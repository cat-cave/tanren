import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { PercolationDecision, SpeculativeDependent } from "../src/engine/contracts/changePercolation.js";
import type {
  ConflictRecoveryDisposition,
  ConflictRecoverySettlement,
  ReplanRouteResult,
} from "../src/engine/contracts/conflictResolution.js";
import type { RebaseResult, WorkspaceVcsCore } from "../src/engine/contracts/workspaceVcsCore.js";
import {
  BaseShiftCoordinator,
  type BaseShiftEventEmitter,
  type BaseShiftGateReworkRouter,
  type BaseShiftPersistence,
  type ConflictResolution,
  type RebaseDecision,
} from "../src/engine/dag/baseShiftCoordinator.js";
import { PercolatingKickOff } from "../src/engine/dag/percolationOperation.js";
import { PgPercolationSettler } from "../src/engine/dag/percolationBuild.js";
import {
  PgRecoveryRouteSettler,
  type RecoveryCapableRunStateWriter,
  type RecoveryRouteSettler,
} from "../src/engine/merge/recoveryRouteSettlement.js";
import { driveOutcomeFromRecoverySettlement } from "../src/engine/merge/driveConflictVerdict.js";

const ORG = "org_recovery";
const PROJECT = "project_recovery";
const SPEC = "spec_recovery";
const RUN = "run_recovery";
const QUEUE = "queue_recovery";

class RecoveryPool {
  readonly selects: unknown[][] = [];
  constructor(private readonly hasTarget = true) {}

  private async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
    if (sql.includes("SELECT org_id FROM projects")) {
      return { rows: [{ org_id: ORG }] };
    }
    if (sql.includes("FROM merge_queue")) {
      this.selects.push(params);
      return { rows: this.hasTarget ? [{ queue_id: QUEUE, org_id: ORG }] : [] };
    }
    return { rows: [] };
  }

  async connect() {
    return { query: this.query.bind(this), release: () => {} };
  }
}

function poolAsPg(pool: RecoveryPool): pg.Pool {
  return pool as unknown as pg.Pool;
}

function writerReturning(
  outcome:
    | { kind: "parked"; newlyParked: boolean }
    | {
        kind: "parking_failed";
        reason: "spec_not_recoverable";
        queueDisposition: "retained";
        retryAfterMs: number;
      },
  calls: Array<Record<string, unknown>>,
  order: string[] = [],
): RecoveryCapableRunStateWriter {
  return {
    async parkRecoveryAndDequeue(input) {
      order.push("park");
      calls.push(input);
      return outcome;
    },
  } as unknown as RecoveryCapableRunStateWriter;
}

function clearRecordingWriter(clears: string[]): RecoveryCapableRunStateWriter {
  return {
    async clearRunPercolationPending(input) {
      clears.push(input.runId);
    },
  } as unknown as RecoveryCapableRunStateWriter;
}

function parkingRequired(message = "fixed point"): ConflictRecoveryDisposition {
  return { kind: "parking_required", message };
}

class RecoveryPersistence implements BaseShiftPersistence {
  readonly order: string[];
  recordReplanCalls = 0;

  constructor(
    private readonly settlement: RecoveryRouteSettler,
    private readonly replanResult: ReplanRouteResult = parkingRequired(),
    order: string[] = [],
  ) {
    this.order = order;
  }

  async repointBase(): Promise<void> {}
  async markInFlight(): Promise<void> {}
  async recordReplan(): Promise<ReplanRouteResult> {
    this.recordReplanCalls += 1;
    return this.replanResult;
  }
  async settleRecovery(input: Parameters<BaseShiftPersistence["settleRecovery"]>[0]) {
    this.order.push("settle");
    return this.settlement.settle(input);
  }
  async clearInFlight(): Promise<void> {
    this.order.push("clear");
  }
}

function dependent(): SpeculativeDependent {
  return {
    specId: SPEC,
    runId: RUN,
    speculativeBase: null,
    integratedAncestorShas: { spec_a: "sha_old" },
    verifiedAncestorShas: { spec_a: "sha_old" },
    lifecycleState: "building",
    openFindingMaxSeverity: "unaudited",
  };
}

const DECISION: PercolationDecision = {
  ancestorSpecId: "spec_a",
  promptness: "immediate",
  fromSha: "sha_old",
  toSha: "sha_new",
  immediateSeverity: "P0",
};

function coordinator(input: {
  persistence: RecoveryPersistence;
  conflicted?: boolean;
  resolution?: ConflictResolution;
  gateRecovery?: ConflictRecoveryDisposition;
  decisions: RebaseDecision[];
}): BaseShiftCoordinator {
  const rebase: RebaseResult = input.conflicted
    ? {
        outcome: "conflicted",
        headSha: "sha_conflicted",
        conflict: { conflictId: "conflict_1", between: { specId: SPEC, otherSpecId: "base" }, paths: ["x.ts"] },
      }
    : { outcome: "clean", headSha: "sha_clean" };
  const workspace = {
    async rebaseOnto() {
      return rebase;
    },
  } as unknown as WorkspaceVcsCore;
  const events: BaseShiftEventEmitter = {
    async emitRebase(event) {
      input.decisions.push(event.decision);
    },
  };
  const gateRework: BaseShiftGateReworkRouter = {
    async routeGateFailToRework() {
      return input.gateRecovery ?? parkingRequired();
    },
  };
  return new BaseShiftCoordinator({
    workspace,
    opener: {
      async open() {
        return { workspaceId: "ws", path: "/ws", branch: "branch", newBaseSha: "base" };
      },
    },
    reGate: {
      async reGate() {
        return input.conflicted ? "passed" : { verdict: "failed", gateError: "gate failed" };
      },
    },
    resolver: {
      async resolve() {
        return input.resolution ?? { resolved: true, headSha: "sha_resolved" };
      },
    },
    persistence: input.persistence,
    nodes: {
      async nodesForDependent() {
        return [];
      },
    },
    events,
    gateRework,
  });
}

async function kickOff(coord: BaseShiftCoordinator) {
  return new PercolatingKickOff({
    stackResolver: {
      async resolveStack() {
        return [{ specId: "spec_a", runId: "run_a", branch: "branch_a" }];
      },
    },
    reexecutor: coord,
  }).kickOff({ projectId: PROJECT, dependent: dependent(), decision: DECISION, mergedAncestorSpecIds: [] });
}

describe("typed recovery settlement — exact atomic authority", () => {
  it("parking_required parks the exact active tuple once", async () => {
    const pool = new RecoveryPool();
    const calls: Array<Record<string, unknown>> = [];
    const settler = new PgRecoveryRouteSettler(
      poolAsPg(pool),
      writerReturning({ kind: "parked", newlyParked: true }, calls),
    );
    await expect(
      settler.settle({ projectId: PROJECT, runId: RUN, specId: SPEC, recovery: parkingRequired() }),
    ).resolves.toEqual({ kind: "parked", newlyParked: true });
    expect(pool.selects).toEqual([[PROJECT, RUN, SPEC]]);
    expect(calls).toEqual([
      { orgId: ORG, projectId: PROJECT, queueId: QUEUE, runId: RUN, specId: SPEC, message: "fixed point" },
    ]);
  });

  it("missing exact owner and retained park failure never fabricate parked", async () => {
    const missingCalls: Array<Record<string, unknown>> = [];
    const missing = new PgRecoveryRouteSettler(
      poolAsPg(new RecoveryPool(false)),
      writerReturning({ kind: "parked", newlyParked: true }, missingCalls),
    );
    await expect(
      missing.settle({ projectId: PROJECT, runId: RUN, specId: SPEC, recovery: parkingRequired() }),
    ).resolves.toMatchObject({ kind: "parking_failed", queueDisposition: "unknown" });
    expect(missingCalls).toEqual([]);

    const retained = new PgRecoveryRouteSettler(
      poolAsPg(new RecoveryPool()),
      writerReturning(
        { kind: "parking_failed", reason: "spec_not_recoverable", queueDisposition: "retained", retryAfterMs: 3_000 },
        [],
      ),
    );
    await expect(
      retained.settle({ projectId: PROJECT, runId: RUN, specId: SPEC, recovery: parkingRequired() }),
    ).resolves.toMatchObject({ kind: "parking_failed", queueDisposition: "retained" });
  });
});

describe("base-shift/percolation consumers preserve settlement truth", () => {
  it("a clean gate fixed point parks before clear and is not reported replanned/reexecuting", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const order: string[] = [];
    const persistence = new RecoveryPersistence(
      new PgRecoveryRouteSettler(
        poolAsPg(new RecoveryPool()),
        writerReturning({ kind: "parked", newlyParked: true }, calls, order),
      ),
      parkingRequired(),
      order,
    );
    const decisions: RebaseDecision[] = [];
    const outcome = await kickOff(coordinator({ persistence, decisions }));
    expect(outcome.result).toBe("parked");
    expect(persistence.order).toEqual(["settle", "park", "clear"]);
    expect(calls).toHaveLength(1);
    expect(decisions).toEqual(["held"]);
    expect(persistence.recordReplanCalls).toBe(0);
  });

  it("resolver parking_required is consumed directly without a second planner route", async () => {
    const persistence = new RecoveryPersistence(
      new PgRecoveryRouteSettler(
        poolAsPg(new RecoveryPool()),
        writerReturning({ kind: "parked", newlyParked: true }, []),
      ),
    );
    const outcome = await kickOff(
      coordinator({
        persistence,
        conflicted: true,
        resolution: { resolved: false, reason: "same conflict", recovery: parkingRequired("resolver fixed point") },
        decisions: [],
      }),
    );
    expect(outcome.result).toBe("parked");
    expect(persistence.recordReplanCalls).toBe(0);
  });

  it("an unresolved resolver without a delegated route consumes recordReplan's typed park result", async () => {
    const persistence = new RecoveryPersistence(
      new PgRecoveryRouteSettler(
        poolAsPg(new RecoveryPool()),
        writerReturning({ kind: "parked", newlyParked: true }, []),
      ),
    );
    const outcome = await kickOff(
      coordinator({
        persistence,
        conflicted: true,
        resolution: { resolved: false, reason: "planner must reconcile" },
        decisions: [],
      }),
    );
    expect(outcome.result).toBe("parked");
    expect(persistence.recordReplanCalls).toBe(1);
  });

  it("parking_failed retains the marker and raises a recoverable hold", async () => {
    const persistence = new RecoveryPersistence(
      new PgRecoveryRouteSettler(
        poolAsPg(new RecoveryPool()),
        writerReturning(
          { kind: "parking_failed", reason: "spec_not_recoverable", queueDisposition: "retained", retryAfterMs: 3_000 },
          [],
        ),
      ),
    );
    await expect(kickOff(coordinator({ persistence, decisions: [] }))).rejects.toMatchObject({
      recoverySettlement: { kind: "parking_failed", queueDisposition: "retained" },
    });
    expect(persistence.order).toEqual(["settle"]);
  });
});

describe("base-shift settlement maps to one outer drive disposition", () => {
  it("preserves owner, completed park, and failed park without a second attempt", () => {
    const owned = {
      kind: "owned" as const,
      receipt: {
        kind: "planner_replan" as const,
        specId: SPEC,
        run: { kind: "already_running" as const, runId: "run_owner" },
      },
    };
    expect(driveOutcomeFromRecoverySettlement(owned, "owned")).toMatchObject({
      kind: "conflict",
      recovery: owned.receipt,
    });
    expect(driveOutcomeFromRecoverySettlement({ kind: "parked", newlyParked: true }, "parked")).toEqual({
      kind: "needs_attention",
      message: "parked",
      parking: "complete",
    });
    expect(
      driveOutcomeFromRecoverySettlement(
        { kind: "parking_failed", message: "retained", queueDisposition: "retained", retryAfterMs: 3_000 },
        "ignored",
      ),
    ).toEqual({ kind: "needs_attention", message: "retained", parking: "parking_failed" });
  });
});

describe("PgPercolationSettler consumes the router disposition before clearing", () => {
  const pending = { ancestorSpecId: "spec_a", toSha: "sha_new", reexecRunId: RUN };

  it("confirmed park clears the marker only after settlement and returns parked", async () => {
    const clears: string[] = [];
    const order: string[] = [];
    const recovery: RecoveryRouteSettler = {
      async settle(input): Promise<ConflictRecoverySettlement> {
        order.push(input.recovery.kind);
        return { kind: "parked", newlyParked: true };
      },
    };
    const settler = new PgPercolationSettler(
      poolAsPg(new RecoveryPool()),
      clearRecordingWriter(clears),
      recovery,
      async () => parkingRequired("percolation fixed point"),
    );

    await expect(
      settler.replan({ projectId: PROJECT, dependent: dependent(), pending, reason: "cannot absorb" }),
    ).resolves.toEqual({ result: "parked" });
    expect(order).toEqual(["parking_required"]);
    expect(clears).toEqual([RUN]);
  });

  it("parking failure retains the marker and cannot masquerade as replanned", async () => {
    const clears: string[] = [];
    const recovery: RecoveryRouteSettler = {
      async settle() {
        return { kind: "parking_failed", message: "retained", queueDisposition: "retained", retryAfterMs: 3_000 };
      },
    };
    const settler = new PgPercolationSettler(
      poolAsPg(new RecoveryPool()),
      clearRecordingWriter(clears),
      recovery,
      async () => parkingRequired(),
    );

    await expect(
      settler.replan({ projectId: PROJECT, dependent: dependent(), pending, reason: "cannot absorb" }),
    ).resolves.toEqual({ result: "held", reason: "retained" });
    expect(clears).toEqual([]);
  });
});
