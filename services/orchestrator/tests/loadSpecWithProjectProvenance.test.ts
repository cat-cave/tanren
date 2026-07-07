// Codex H3 #7 — the SELECT-and-decode side of the triage-routing PROVENANCE
// round-trip. PR #755 added the four `specs.parent_spec_id / source_finding_ids
// / origin_triage_task_id / origin_run_id` columns; PR #768 added the
// re-drive dedupe read. Before this test's fix, `loadSpecWithProject`'s SELECT
// omitted the four columns AND the returned `SpecContract` had no
// `triageProvenance` field — every downstream reader (run bootstrap, DAG
// snapshots, dashboard reads) was blind to routing origin. This pins the
// decode: a routed spec exposes `triageProvenance` with each column populated;
// a non-routed spec omits the block.
//
// Companion to `createSpecTriageProvenance.test.ts` (the INSERT-side
// round-trip). Together they close the write→read loop the columns exist for.

import { describe, expect, it } from "vitest";
import { loadSpecWithProject } from "../src/engine/workflow/projectSpecRowSchema.js";

interface FakeRow {
  parent_spec_id: string | null;
  source_finding_ids: unknown;
  origin_triage_task_id: string | null;
  origin_run_id: string | null;
}

function fakePool(row: FakeRow): {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
} {
  return {
    query: async (_sql: string, _params?: unknown[]) => ({
      rows: [
        {
          project_id: "project_pro",
          project_org_id: "org_pro",
          spec_org_id: "org_pro",
          name: "Product",
          repo_url: "https://github.com/example/product",
          default_branch: "main",
          runner_image: "ghcr.io/example/runner:v1",
          allocator: "local-docker",
          config: { version: 1 },
          spec_id: "spec_routed",
          title: "routed spec",
          description: "auto-routed",
          acceptance_criteria: ["a"],
          depends_on: [],
          status: "open",
          priority: "tbd",
          mode: "from_scratch",
          parent_spec_id: row.parent_spec_id,
          source_finding_ids: row.source_finding_ids,
          origin_triage_task_id: row.origin_triage_task_id,
          origin_run_id: row.origin_run_id,
        },
      ],
      rowCount: 1,
    }),
  };
}

describe("loadSpecWithProject — triage PROVENANCE decode (Codex H3 #7)", () => {
  // A routed spec (parent_spec_id set) surfaces the full triageProvenance block
  // — the four columns land on the returned SpecContract so downstream readers
  // can render the routing chain WITHOUT parsing the discovery jsonb blob.
  it("exposes triageProvenance when parent_spec_id is non-null", async () => {
    const pool = fakePool({
      parent_spec_id: "spec_parent",
      source_finding_ids: ["finding_a", "finding_b"],
      origin_triage_task_id: "task_triage",
      origin_run_id: "run_source",
    });
    const loaded = await loadSpecWithProject(pool, "spec_routed");
    expect(loaded.spec.triageProvenance).toEqual({
      parentSpecId: "spec_parent",
      sourceFindingIds: ["finding_a", "finding_b"],
      originTriageTaskId: "task_triage",
      originRunId: "run_source",
    });
  });

  // Non-routed spec (operator create / discovery accept / seed): the four
  // columns are null on the row, and the returned SpecContract omits
  // triageProvenance entirely — matching the shape a pre-migration spec had.
  it("omits triageProvenance when parent_spec_id is null (non-routed)", async () => {
    const pool = fakePool({
      parent_spec_id: null,
      source_finding_ids: null,
      origin_triage_task_id: null,
      origin_run_id: null,
    });
    const loaded = await loadSpecWithProject(pool, "spec_routed");
    expect(loaded.spec.triageProvenance).toBeUndefined();
  });

  // Legacy row: a routed spec whose `source_finding_ids` slot is null (predates
  // canonicalization or the array was unset). The parent trail STILL
  // identifies the routed spec; the reader degrades sourceFindingIds to [] so
  // the block still renders — the parent_spec_id + origin_* fields are the
  // load-bearing identity, not the finding array.
  it("degrades a null source_finding_ids to [] on a legacy routed row", async () => {
    const pool = fakePool({
      parent_spec_id: "spec_parent",
      source_finding_ids: null,
      origin_triage_task_id: "task_triage",
      origin_run_id: "run_source",
    });
    const loaded = await loadSpecWithProject(pool, "spec_routed");
    expect(loaded.spec.triageProvenance).toEqual({
      parentSpecId: "spec_parent",
      sourceFindingIds: [],
      originTriageTaskId: "task_triage",
      originRunId: "run_source",
    });
  });

  // The SELECT itself must NAME the four columns — a regression that drops
  // them silently would make every routed spec look non-routed at read time.
  // This asserts the SQL contract, mirroring the WRITE-side guard in
  // `createSpecTriageProvenance.test.ts`.
  it("the SELECT statement names the four provenance columns", async () => {
    let seenSql = "";
    const pool = {
      query: async (sql: string) => {
        seenSql = sql;
        return {
          rows: [
            {
              project_id: "project_pro",
              project_org_id: "org_pro",
              spec_org_id: "org_pro",
              name: "Product",
              repo_url: "https://github.com/example/product",
              default_branch: "main",
              runner_image: "ghcr.io/example/runner:v1",
              allocator: "local-docker",
              config: { version: 1 },
              spec_id: "spec_x",
              title: "x",
              description: "x",
              acceptance_criteria: ["a"],
              depends_on: [],
              status: "open",
              priority: "tbd",
              mode: "from_scratch",
              parent_spec_id: null,
              source_finding_ids: null,
              origin_triage_task_id: null,
              origin_run_id: null,
            },
          ],
          rowCount: 1,
        };
      },
    };
    await loadSpecWithProject(pool, "spec_x");
    expect(seenSql).toContain("s.parent_spec_id");
    expect(seenSql).toContain("s.source_finding_ids");
    expect(seenSql).toContain("s.origin_triage_task_id");
    expect(seenSql).toContain("s.origin_run_id");
  });
});
