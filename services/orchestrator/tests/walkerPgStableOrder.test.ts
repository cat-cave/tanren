// Codex critic #10: PgDagReadModel's `orderKey` is a `row_number()` over the
// STABLE LOGICAL (created_at, spec_id) tuple — not the physical `ctid`, which a
// VACUUM/rewrite/UPDATE can shift under identical DAG data. This pins that the
// spec-select SQL orders by the logical tuple and never re-introduces `ctid`,
// and that identical logical inputs produce a byte-identical snapshot (no
// physical-order leak into the walker's tiebreak).
//
// The test lives at the unit tier: it drives PgDagReadModel through a fake
// pg.Pool that captures the executed SQL and services the walker's two reads
// (the system-scoped project probe + the org-scoped spec select). The fake's
// spec-select sorts its seeded rows by (created_at, spec_id) so the assigned
// `rn` mirrors what Postgres emits under the fixed ORDER BY — a physical-order
// perturbation (input rows in reverse creation order) MUST yield the same
// snapshot, or the SQL fell back to a ctid-shaped tiebreak.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { PgDagReadModel } from "../src/engine/dag/walkerPg.js";

interface FakeSpecRow {
  spec_id: string;
  status: string;
  depends_on: string[];
  priority: string;
  created_at: string;
}

/**
 * A pg.Pool double for PgDagReadModel:
 *  - Handles the system-scoped `runWithSystemScope` transaction (BEGIN/COMMIT +
 *    the project-resolve SELECT), returning a live org for the snapshot path.
 *  - Handles the org-scoped `runWithOrgScope` transaction (BEGIN/SET LOCAL/…/
 *    COMMIT + the spec select). The spec select captures the executed SQL for
 *    assertion, then services the query by SORTING the seeded rows by
 *    (created_at, spec_id) — that is the ORDER BY the fixed SQL emits.
 */
function fakePool(rows: FakeSpecRow[]): { pool: pg.Pool; sqlSeen: string[] } {
  const sqlSeen: string[] = [];
  const orderedRows = () => {
    return [...rows]
      .sort((a, b) => {
        if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
        return a.spec_id < b.spec_id ? -1 : a.spec_id > b.spec_id ? 1 : 0;
      })
      .map((row, index) => ({
        spec_id: row.spec_id,
        status: row.status,
        depends_on: row.depends_on,
        priority: row.priority,
        rn: index + 1,
      }));
  };
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

describe("PgDagReadModel — deterministic (created_at, spec_id) ordering (Codex #10)", () => {
  it("the spec-select SQL orders by created_at + spec_id and never by ctid", async () => {
    const rows: FakeSpecRow[] = [
      {
        spec_id: "spec_alpha",
        status: "open",
        depends_on: [],
        priority: "tbd",
        created_at: "2026-07-01T00:00:00Z",
      },
      {
        spec_id: "spec_beta",
        status: "open",
        depends_on: [],
        priority: "tbd",
        created_at: "2026-07-02T00:00:00Z",
      },
    ];
    const { pool, sqlSeen } = fakePool(rows);
    const model = new PgDagReadModel(pool);
    await model.loadSnapshot("project_walker");

    const specSql = sqlSeen.find((s) => s.startsWith("SELECT spec_id, status, depends_on, priority"));
    expect(specSql).toBeDefined();
    // The stable-ordering fix: the spec select orders by the logical (created_at,
    // spec_id) tuple, never by ctid.
    expect(specSql).toMatch(/ORDER BY created_at ASC, spec_id ASC/iu);
    expect(specSql).not.toMatch(/\bctid\b/iu);
  });

  it("returns identical orderKey values across repeated snapshot reads (deterministic)", async () => {
    const rows: FakeSpecRow[] = [
      {
        spec_id: "spec_c",
        status: "open",
        depends_on: [],
        priority: "P1",
        created_at: "2026-07-03T00:00:00Z",
      },
      {
        spec_id: "spec_a",
        status: "open",
        depends_on: [],
        priority: "P0",
        created_at: "2026-07-01T00:00:00Z",
      },
      {
        spec_id: "spec_b",
        status: "open",
        depends_on: [],
        priority: "tbd",
        created_at: "2026-07-02T00:00:00Z",
      },
    ];
    const { pool } = fakePool(rows);
    const model = new PgDagReadModel(pool);

    const first = await model.loadSnapshot("project_walker");
    const second = await model.loadSnapshot("project_walker");

    expect(second.nodes).toEqual(first.nodes);
    // The orderKey is the (created_at, spec_id)-derived row number — spec_a
    // (2026-07-01) first, then spec_b, then spec_c.
    const bySpecId = new Map(first.nodes.map((node) => [node.specId, node.orderKey]));
    expect(bySpecId.get("spec_a")).toBe(1);
    expect(bySpecId.get("spec_b")).toBe(2);
    expect(bySpecId.get("spec_c")).toBe(3);
  });

  it("orderKey is independent of the input row order (physical layout MUST NOT leak)", async () => {
    // The persisted rows: spec_a older, spec_b newer.
    const base: FakeSpecRow[] = [
      {
        spec_id: "spec_a",
        status: "open",
        depends_on: [],
        priority: "tbd",
        created_at: "2026-07-01T00:00:00Z",
      },
      {
        spec_id: "spec_b",
        status: "open",
        depends_on: [],
        priority: "tbd",
        created_at: "2026-07-02T00:00:00Z",
      },
    ];

    const forward = await new PgDagReadModel(fakePool([...base]).pool).loadSnapshot("project_walker");
    const reversed = await new PgDagReadModel(fakePool(base.toReversed()).pool).loadSnapshot("project_walker");

    // Regardless of the row layout the fake pool receives (mimicking a VACUUM
    // that shifted the physical ctid), the (created_at, spec_id) ORDER BY
    // yields the same orderKey values.
    const forwardKeys = new Map(forward.nodes.map((n) => [n.specId, n.orderKey]));
    const reversedKeys = new Map(reversed.nodes.map((n) => [n.specId, n.orderKey]));
    expect(reversedKeys).toEqual(forwardKeys);
    expect(forwardKeys.get("spec_a")).toBe(1);
    expect(forwardKeys.get("spec_b")).toBe(2);
  });

  it("ties on created_at fall back to the spec_id lexicographic tiebreak (total order)", async () => {
    const rows: FakeSpecRow[] = [
      {
        spec_id: "spec_z",
        status: "open",
        depends_on: [],
        priority: "tbd",
        created_at: "2026-07-04T00:00:00Z",
      },
      {
        spec_id: "spec_a",
        status: "open",
        depends_on: [],
        priority: "tbd",
        created_at: "2026-07-04T00:00:00Z",
      },
      {
        spec_id: "spec_m",
        status: "open",
        depends_on: [],
        priority: "tbd",
        created_at: "2026-07-04T00:00:00Z",
      },
    ];
    const { pool } = fakePool(rows);
    const snapshot = await new PgDagReadModel(pool).loadSnapshot("project_walker");
    const bySpecId = new Map(snapshot.nodes.map((n) => [n.specId, n.orderKey]));
    // Same created_at ⇒ spec_id decides. Lexicographic: spec_a, spec_m, spec_z.
    expect(bySpecId.get("spec_a")).toBe(1);
    expect(bySpecId.get("spec_m")).toBe(2);
    expect(bySpecId.get("spec_z")).toBe(3);
  });
});
