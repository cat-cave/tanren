// Codex H3 #9 — the DAG-snapshot side of the triage-routing PROVENANCE
// round-trip. `PgDagReadModel.loadSnapshot` now SELECTs the four routing
// columns (Claude RA2, migration 0025) and hydrates `DagSpecNode.triageProvenance`
// for every routed spec node. Before this fix, DAG snapshots omitted routing
// origin entirely — an operator viewing the DAG could NOT see which specs
// were auto-routed by triage, only what the persisted status classified them
// as. This pins the enrichment: a routed spec node exposes the trail; a
// non-routed spec node omits it; and the SELECT itself names the four
// columns so a silent drop is caught in CI.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { PgDagReadModel } from "../src/engine/dag/walkerPg.js";

interface FakeSpecRow {
  spec_id: string;
  status: string;
  depends_on: string[];
  priority: string;
  created_at: string;
  parent_spec_id: string | null;
  source_finding_ids: string[] | null;
  origin_triage_task_id: string | null;
  origin_run_id: string | null;
}

function fakePool(rows: FakeSpecRow[]): { pool: pg.Pool; sqlSeen: string[] } {
  const sqlSeen: string[] = [];
  const orderedRows = () =>
    [...rows]
      .sort((a, b) => {
        if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
        return a.spec_id < b.spec_id ? -1 : a.spec_id > b.spec_id ? 1 : 0;
      })
      .map((row, index) => ({
        spec_id: row.spec_id,
        status: row.status,
        depends_on: row.depends_on,
        priority: row.priority,
        parent_spec_id: row.parent_spec_id,
        source_finding_ids: row.source_finding_ids,
        origin_triage_task_id: row.origin_triage_task_id,
        origin_run_id: row.origin_run_id,
        rn: index + 1,
      }));
  const client = {
    query: async (sql: string): Promise<{ rows: unknown[]; rowCount: number }> => {
      const text = sql.trim();
      sqlSeen.push(text);
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/u.test(text)) {
        return { rows: [], rowCount: 0 };
      }
      if (text.startsWith("SELECT org_id, lifecycle FROM projects")) {
        return { rows: [{ org_id: "org_walker", lifecycle: "active" }], rowCount: 1 };
      }
      if (text.startsWith("SELECT spec_id, status, depends_on, priority")) {
        const out = orderedRows();
        return { rows: out, rowCount: out.length };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const pool = {
    connect: async () => client,
    query: client.query,
  } as unknown as pg.Pool;
  return { pool, sqlSeen };
}

describe("PgDagReadModel — triage PROVENANCE on DAG nodes (Codex H3 #9)", () => {
  // A routed node (parent_spec_id set) surfaces the full triageProvenance
  // trail on the DagSpecNode. Consumers of the snapshot (the pg-backed walker,
  // the dashboard DAG view assembler) get the routing chain without a second
  // SELECT — the origin is inline with the node.
  it("hydrates triageProvenance on a routed spec node", async () => {
    const { pool } = fakePool([
      {
        spec_id: "spec_routed",
        status: "open",
        depends_on: [],
        priority: "tbd",
        created_at: "2026-07-05T00:00:00Z",
        parent_spec_id: "spec_parent",
        source_finding_ids: ["finding_1", "finding_2"],
        origin_triage_task_id: "task_triage_a",
        origin_run_id: "run_source_a",
      },
    ]);
    const snap = await new PgDagReadModel(pool).loadSnapshot("project_walker");
    const routed = snap.nodes.find((n) => n.specId === "spec_routed");
    expect(routed?.triageProvenance).toEqual({
      parentSpecId: "spec_parent",
      sourceFindingIds: ["finding_1", "finding_2"],
      originTriageTaskId: "task_triage_a",
      originRunId: "run_source_a",
    });
  });

  // A non-routed node (parent_spec_id null) has no triageProvenance — the DAG
  // view renders it as an operator-authored / discovery / seed node with no
  // routing chain.
  it("omits triageProvenance on a non-routed spec node", async () => {
    const { pool } = fakePool([
      {
        spec_id: "spec_seed",
        status: "open",
        depends_on: [],
        priority: "P0",
        created_at: "2026-07-01T00:00:00Z",
        parent_spec_id: null,
        source_finding_ids: null,
        origin_triage_task_id: null,
        origin_run_id: null,
      },
    ]);
    const snap = await new PgDagReadModel(pool).loadSnapshot("project_walker");
    const seed = snap.nodes.find((n) => n.specId === "spec_seed");
    expect(seed?.triageProvenance).toBeUndefined();
  });

  // The SELECT statement itself names the four provenance columns — a
  // regression that drops them silently would make every routed spec node
  // look non-routed at DAG-view time. Guarded here alongside the existing
  // walker-order guard (`walkerPgStableOrder.test.ts`).
  it("the DAG snapshot SELECT names the four provenance columns", async () => {
    const { pool, sqlSeen } = fakePool([
      {
        spec_id: "spec_x",
        status: "open",
        depends_on: [],
        priority: "tbd",
        created_at: "2026-07-05T00:00:00Z",
        parent_spec_id: null,
        source_finding_ids: null,
        origin_triage_task_id: null,
        origin_run_id: null,
      },
    ]);
    await new PgDagReadModel(pool).loadSnapshot("project_walker");
    const specSql = sqlSeen.find((s) => s.startsWith("SELECT spec_id, status, depends_on, priority"));
    expect(specSql).toBeDefined();
    expect(specSql).toMatch(/parent_spec_id/u);
    expect(specSql).toMatch(/source_finding_ids/u);
    expect(specSql).toMatch(/origin_triage_task_id/u);
    expect(specSql).toMatch(/origin_run_id/u);
  });

  // Ordering / phase classification MUST remain unchanged when triage
  // provenance is added — this is a display-only enrichment. Pin that: two
  // routed + one non-routed spec produce the same ordered ids the pre-fix
  // snapshot produced (creation-order tiebreak within `tbd` priority).
  it("triage provenance is display-only — ordering + phase classification unchanged", async () => {
    const { pool } = fakePool([
      {
        spec_id: "spec_b",
        status: "in_flight",
        depends_on: [],
        priority: "tbd",
        created_at: "2026-07-02T00:00:00Z",
        parent_spec_id: "spec_a",
        source_finding_ids: ["f1"],
        origin_triage_task_id: "task_triage",
        origin_run_id: "run_parent",
      },
      {
        spec_id: "spec_a",
        status: "merged",
        depends_on: [],
        priority: "tbd",
        created_at: "2026-07-01T00:00:00Z",
        parent_spec_id: null,
        source_finding_ids: null,
        origin_triage_task_id: null,
        origin_run_id: null,
      },
    ]);
    const snap = await new PgDagReadModel(pool).loadSnapshot("project_walker");
    const byId = new Map(snap.nodes.map((n) => [n.specId, n]));
    expect(byId.get("spec_a")?.phase).toBe("done");
    expect(byId.get("spec_b")?.phase).toBe("in_flight");
    expect(byId.get("spec_a")?.orderKey).toBe(1);
    expect(byId.get("spec_b")?.orderKey).toBe(2);
  });
});
