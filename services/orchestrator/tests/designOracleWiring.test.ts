// WS-D4 native design subsystem — the design ORACLE is now wired LIVE into the spec
// loop (the verify→re-drive half of the design loop). These tests prove the wiring the
// integration review flagged as the P1 "oracle unwired" gap:
//   - when the run carries a design actor AND the project HAS a design contract, the
//     oracle stage RUNS (a `designOracle` task + `designOracle.verdict` event) and its
//     fidelity findings flow into the SAME triage input as the auditor/demo — so a
//     genuine design-fidelity gap RE-DRIVES the writer like any other gate finding;
//   - when the project has NO contract, the stage NO-OPS cleanly (no task, no finding,
//     no answerer call) — never a fabricated default;
//   - when the run carries NO design actor (a no-org / unit path), the stage is skipped.
//
// Mirrors plannerLoop.test.ts's demo-run gating tests (the exact wiring template) but for
// the design oracle. "then" in the faked behavior rows is the BDD Given/When/Then column
// vocabulary, not a thenable — the awaitable-object lint does not apply to these fixtures.
/* eslint-disable unicorn/no-thenable */
import { describe, expect, it } from "vitest";
import { runSubtaskLoop } from "../src/engine/workflow/subtaskLoop.js";
import type { ActorContext } from "../src/auth/schemas.js";
import { parseDesignContract } from "../src/engine/design/designContract.js";
import {
  cleanAudit,
  completeCheck,
  convergenceProgress,
  defaultLoopInput,
  FakePool,
  makeAuditor,
  makeChecker,
  makeConvergence,
  makeDemoRun,
  makeDesignOracle,
  makePlanner,
  makeTriage,
  makeWriter,
  triageAllSpecs,
  buildPlan,
} from "./helpers/plannerLoopHelpers.js";
import { InMemoryRunStateWriter } from "./fixtures/inMemoryRunStateWriter.js";

const ORG = "org_design";
const actor: ActorContext = {
  userId: "design-writer-context",
  orgId: ORG,
  projectId: "project_test",
  scopes: ["platform:admin"],
  source: "local_dev",
};
const designOracleActor = { actor, actorRef: { kind: "operator" as const } };

const webContract = () =>
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

// A FakePool that ALSO routes the three design stores' SELECTs (design_contracts /
// personas / behaviors). `hasContract: false` ⇒ the design_contracts read returns no
// row (the no-contract path); otherwise it serves the web contract + its seeded refs.
class DesignOraclePool extends FakePool {
  constructor(private readonly hasContract: boolean) {
    super();
  }
  override async query(
    sql: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<{ rows: ReadonlyArray<Record<string, unknown>>; rowCount: number }> {
    const trimmed = sql.trim();
    const now = new Date("2026-01-01T00:00:00Z");
    if (trimmed.includes("FROM design_contracts")) {
      if (!this.hasContract) return { rows: [], rowCount: 0 };
      const contract = webContract();
      const requestedMode = typeof params[1] === "string" ? String(params[1]) : "from_scratch";
      return {
        rows: [
          {
            id: "design_1",
            org_id: ORG,
            project_id: "project_test",
            version: 2,
            mode: requestedMode,
            domain: contract.domain,
            contract,
          },
        ],
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
    return super.query(sql, params);
  }
}

// Build a loop input over a DesignOraclePool with a design oracle wired to emit `verdict`.
function designLoopInput(opts: {
  hasContract: boolean;
  wireActor: boolean;
  oracleFindings: Array<{ id: string; severity: "P0" | "P1" | "P2" | "P3"; title: string; body: string }>;
}) {
  const pool = new DesignOraclePool(opts.hasContract);
  const { input, events } = defaultLoopInput({
    adapters: {
      ...defaultLoopInput().input.adapters,
      planner: makePlanner([buildPlan([{ title: "T1", intent: "Touch README", behaviorIds: ["B1"] }])]),
      writer: makeWriter(["diff --git README\n+ok\n"]),
      checker: makeChecker([completeCheck]),
      auditor: makeAuditor([cleanAudit]),
      demoRun: makeDemoRun([{ findings: [], summary: "ok" }]),
      // The design oracle returns a fidelity verdict; its findings should reach triage.
      designOracle: makeDesignOracle([
        { verificationMode: "static-surface-inspection", findings: opts.oracleFindings, summary: "inspected surfaces" },
      ]),
      // A fidelity finding routes to a NEW spec (proves it reached triage) and PASSES.
      triage: makeTriage([triageAllSpecs]),
      convergence: makeConvergence([convergenceProgress]),
    },
    ...(opts.wireActor && { designOracleActor }),
  });
  // Replace the helper's default FakePool with the design-aware pool. Audit
  // finding D3/H3 sweep: also re-wire the writer's forwarders so its task
  // INSERTs land on THIS pool's `tasks` array (the test asserts on it).
  (input as { pool: unknown }).pool = pool;
  (input as { runStateWriter: unknown }).runStateWriter = new InMemoryRunStateWriter({
    forwardAppend: (e) => events.append(e),
    forwardInsertTask: (insert) => {
      pool.tasks.push({
        taskId: insert.taskId,
        runId: insert.runId,
        kind: insert.kind,
        title: insert.title,
        parentTaskId: insert.parentTaskId ?? null,
        status: insert.status,
        outcome: null,
        failureKind: null,
        cli: insert.cli,
      });
    },
  });
  return { input, pool, events };
}

describe("design-oracle live wiring (WS-D4)", () => {
  it("runs the oracle + feeds its fidelity findings into triage (re-drive) when a contract exists", async () => {
    const { input, pool, events } = designLoopInput({
      hasContract: true,
      wireActor: true,
      oracleFindings: [
        { id: "coverage-invite", severity: "P1", title: "Invite flow has no designed surface", body: "no invite UI" },
      ],
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
    if (outcome.kind !== "passed") return;
    // The design-oracle stage materialized a task + emitted its verdict event.
    expect(pool.tasks.some((t) => t.kind === "designOracle")).toBe(true);
    expect(events.events.some((e) => e.eventType === "designOracle.started")).toBe(true);
    expect(events.events.some((e) => e.eventType === "designOracle.verdict")).toBe(true);
    // The fidelity finding reached triage and routed to a new spec (the re-drive currency).
    expect(outcome.newSpecs).toHaveLength(1);
  });

  it("no-ops cleanly (no task, no answerer call) when the project has NO design contract", async () => {
    const oracle = makeDesignOracle([
      { verificationMode: "x", findings: [{ id: "x", severity: "P1", title: "x", body: "x" }], summary: "x" },
    ]);
    const pool = new DesignOraclePool(false);
    const { input, events } = defaultLoopInput({
      adapters: { ...defaultLoopInput().input.adapters, designOracle: oracle },
      designOracleActor,
    });
    (input as { pool: unknown }).pool = pool;
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
    // No contract ⇒ no design-oracle task, no verdict event, AND the oracle answerer is
    // never invoked (no fabricated verification).
    expect(pool.tasks.some((t) => t.kind === "designOracle")).toBe(false);
    expect(events.events.some((e) => e.eventType === "designOracle.verdict")).toBe(false);
    expect(oracle.calls).toHaveLength(0);
  });

  it("is skipped entirely when no design actor is wired (no-org / unit path)", async () => {
    const oracle = makeDesignOracle([
      { verificationMode: "x", findings: [{ id: "x", severity: "P1", title: "x", body: "x" }], summary: "x" },
    ]);
    const pool = new DesignOraclePool(true);
    const { input, events } = defaultLoopInput({
      adapters: { ...defaultLoopInput().input.adapters, designOracle: oracle },
      // designOracleActor deliberately OMITTED.
    });
    (input as { pool: unknown }).pool = pool;
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
    expect(pool.tasks.some((t) => t.kind === "designOracle")).toBe(false);
    expect(events.events.some((e) => e.eventType === "designOracle.started")).toBe(false);
    expect(oracle.calls).toHaveLength(0);
  });
});
