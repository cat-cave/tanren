// cspell:ignore premerge
// ds-6 — the DesignAwareDeliveryCoordinator, exercised with a fake org-scoped pool + a fake
// proof-unit repository + a fake event store. Proves the PRE-MERGE seam genuinely binds the
// eager design matrix (records one immutable design proof-unit per scenario, keyed by the
// frozen six-input design proof key, bound to the integration node) and is a clean no-op for
// a project with no composed design system; and that a PRODUCTION wake for a run with no
// resolvable delivery records NOTHING (fail-closed — never a fabricated green link).

import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetSystemPool, setSystemPool } from "@tanren/db";
import { DesignAwareDeliveryCoordinator } from "../src/engine/design/queue/designAwareDeliveryCoordinator.js";
import type { EventStore } from "../src/engine/eventStore.js";
import type {
  IntegrationProofUnit,
  IntegrationProofUnitRepository,
} from "../src/engine/repositories/integrationProofUnits.js";

const SHA = (c: string): string => `sha256:${c.repeat(64)}`;

interface Recorded {
  kind: string;
  subjectId: string;
  verdict: string;
  artifactHash?: string;
  sourceNodeId?: string;
}

function fakeRepo(reusable?: IntegrationProofUnit): {
  repo: IntegrationProofUnitRepository;
  recorded: Recorded[];
  recordSpy: ReturnType<typeof vi.fn>;
} {
  const recorded: Recorded[] = [];
  const record = vi.fn<IntegrationProofUnitRepository["record"]>(async (input) => {
    recorded.push({
      kind: input.kind,
      subjectId: input.subjectId,
      verdict: input.verdict,
      ...(input.artifactHash === undefined ? {} : { artifactHash: input.artifactHash }),
      ...(input.sourceNodeId === undefined ? {} : { sourceNodeId: input.sourceNodeId }),
    });
    return { ...input, proofUnitId: `pu-${recorded.length}` };
  });
  const repo: IntegrationProofUnitRepository = {
    findReusable: vi.fn<IntegrationProofUnitRepository["findReusable"]>(async () => reusable),
    record,
    attachEvaluation: vi.fn<IntegrationProofUnitRepository["attachEvaluation"]>(async () => {}),
    recordEdges: vi.fn<IntegrationProofUnitRepository["recordEdges"]>(async () => {}),
    evaluationGraph: vi.fn<IntegrationProofUnitRepository["evaluationGraph"]>(async () => ({ units: [], edges: [] })),
    nodeProofState: vi.fn<IntegrationProofUnitRepository["nodeProofState"]>(async () => {}),
    stampNodeProof: vi.fn<IntegrationProofUnitRepository["stampNodeProof"]>(async () => {}),
  };
  return { repo, recorded, recordSpy: record };
}

function fakeEvents(): { events: EventStore; appended: Array<{ eventType: string; payload: unknown }> } {
  const appended: Array<{ eventType: string; payload: unknown }> = [];
  const append = vi.fn<(input: { eventType: string; payload: unknown }) => Promise<void>>(async (input) => {
    appended.push({ eventType: input.eventType, payload: input.payload });
  });
  const events = { append, appendIfAbsent: vi.fn<() => Promise<void>>(async () => {}) } as unknown as EventStore;
  return { events, appended };
}

type FakeRows = { rows: Record<string, unknown>[]; rowCount: number };

/** A fake org-scoped pool answering the pre-merge design-binding reads. `verdictRows` empty ⇒
 * no design system → the coordinator is a clean no-op. */
function fakePool(opts: {
  verdictRows?: Record<string, unknown>[];
  releaseRows?: Record<string, unknown>[];
  fragmentRows?: Record<string, unknown>[];
}): pg.Pool {
  const query = vi.fn<(sql: string) => Promise<FakeRows>>(async (sql) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.startsWith("SET LOCAL")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM design_render_land_verdicts")) {
      const rows = opts.verdictRows ?? [];
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM design_system_releases")) {
      const rows = opts.releaseRows ?? [];
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM design_fragments")) {
      const rows = opts.fragmentRows ?? [];
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM release_instances") || sql.includes("FROM events")) {
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const client = { query, release: vi.fn<() => void>() };
  return { connect: vi.fn<() => Promise<typeof client>>(async () => client) } as unknown as pg.Pool;
}

const VERDICT_ROW = {
  outcome: "passed",
  accessibility_standard: "wcag21aa",
  design_contract_version: "1",
  release_id: "rel-1",
  contract_digest: SHA("c"),
  failing_scenario_key: null,
  failing_rule_ids: [],
  checkpoint_count: 2,
  checkpoints: [
    { checkpointId: "button/light/desktop", verdict: "passed", failingRuleIds: [] },
    { checkpointId: "card/dark/mobile", verdict: "passed", failingRuleIds: [] },
  ],
};

describe("ds-6 DesignAwareDeliveryCoordinator", () => {
  afterEach(() => {
    resetSystemPool();
  });

  it("pre_merge: is a clean no-op for a project with NO composed design system", async () => {
    const { repo, recorded } = fakeRepo();
    const { events } = fakeEvents();
    const coordinator = new DesignAwareDeliveryCoordinator({
      pool: fakePool({}),
      eventStore: events,
      proofUnits: repo,
    });
    await coordinator.run({
      phase: "pre_merge",
      orgId: "org-a",
      projectId: "proj-a",
      integrationNodeId: "node-1",
      runId: "run-1",
    });
    expect(recorded).toHaveLength(0);
    expect(repo.record).not.toHaveBeenCalled();
  });

  it("pre_merge: records one immutable design proof-unit per eager cell, bound to the node", async () => {
    const { repo, recorded } = fakeRepo();
    const { events } = fakeEvents();
    const pool = fakePool({
      verdictRows: [VERDICT_ROW],
      releaseRows: [{ digest: SHA("a"), design_system_id: "ds-1" }],
      fragmentRows: [{ digest: SHA("1") }, { digest: SHA("2") }],
    });
    const coordinator = new DesignAwareDeliveryCoordinator({ pool, eventStore: events, proofUnits: repo });
    await coordinator.run({
      phase: "pre_merge",
      orgId: "org-a",
      projectId: "proj-a",
      integrationNodeId: "node-1",
      runId: "run-1",
    });

    expect(recorded).toHaveLength(2);
    for (const cell of recorded) {
      expect(cell.kind).toBe("design_delivery_scenario");
      expect(cell.verdict).toBe("pass");
      expect(cell.sourceNodeId).toBe("node-1");
      expect(cell.artifactHash).toBe(SHA("a"));
      // subjectId is `<scenarioKey>::<designProofKey>` — the frozen six-input key is embedded.
      expect(cell.subjectId).toMatch(/^.+::sha256:[0-9a-f]{64}$/u);
    }
    const scenarioKeys = recorded.map((cell) => cell.subjectId.split("::")[0]).sort();
    expect(scenarioKeys).toEqual(["button/light/desktop", "card/dark/mobile"]);
  });

  it("pre_merge: an exact-key REUSE emits `designSystem.proof.reused` and records no fresh unit", async () => {
    const reusable: IntegrationProofUnit = {
      orgId: "org-a",
      projectId: "proj-a",
      proofUnitId: "pu-prior",
      kind: "design_delivery_scenario",
      subjectId: "button/light/desktop",
      inputHash: SHA("9"),
      verdict: "pass",
      quarantineEpoch: 0,
    };
    const { repo, recorded } = fakeRepo(reusable);
    const { events, appended } = fakeEvents();
    const pool = fakePool({
      verdictRows: [VERDICT_ROW],
      releaseRows: [{ digest: SHA("a"), design_system_id: "ds-1" }],
      fragmentRows: [{ digest: SHA("1") }],
    });
    const coordinator = new DesignAwareDeliveryCoordinator({ pool, eventStore: events, proofUnits: repo });
    await coordinator.run({
      phase: "pre_merge",
      orgId: "org-a",
      projectId: "proj-a",
      integrationNodeId: "node-1",
      runId: "run-1",
    });

    expect(recorded).toHaveLength(0);
    expect(appended.filter((e) => e.eventType === "designSystem.proof.reused")).toHaveLength(2);
  });

  it("production: a run with no resolvable delivery records NOTHING (fail-closed, never a green link)", async () => {
    // System-scope reads (merge.completed) return empty → no delivery coordinates resolve.
    setSystemPool(fakePool({}));
    const { repo, recorded } = fakeRepo();
    const { events } = fakeEvents();
    const coordinator = new DesignAwareDeliveryCoordinator({
      pool: fakePool({}),
      eventStore: events,
      proofUnits: repo,
    });
    await coordinator.check("run-unmerged");
    expect(recorded).toHaveLength(0);
    expect(repo.record).not.toHaveBeenCalled();
  });
});
