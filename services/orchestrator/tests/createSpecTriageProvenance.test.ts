// Claude RA2 — round-trip proof: the four triage-routing provenance fields on
// CreateSpecInput.triageProvenance are THREADED through `createSpec` into the
// `INSERT INTO specs` statement (positional parameters $11–$14). Asserts the
// SQL params so a regression that drops the provenance en route to the DB
// (silently losing the origin trail for a routed spec) is caught. This is the
// first-class provenance that makes routed specs queryable — before it, the
// routing lived only in the discovery jsonb metadata blob.
//
// Companion to `createSpecModePersistence.test.ts` (the `mode` round-trip). The
// downstream materializer wiring is exercised by `plannerRunTriageNewSpecs`'s
// existing tests — this file is the SQL-boundary guard.

import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/index.js";
import { createSpec, type CreateSpecInput } from "../src/engine/workflow/projectSpec.js";

class CapturingPool {
  readonly projects = new Map<string, { projectId: string; orgId: string | null }>();
  readonly memberships: Array<{ projectId: string; userId: string; role: string }> = [];
  readonly specInserts: Array<{ sql: string; params: unknown[] }> = [];

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const trimmed = sql.trim();
    if (trimmed.startsWith("SELECT project_id FROM projects WHERE project_id = $1")) {
      const project = this.projects.get(String(params[0]));
      return {
        rows: project === undefined ? [] : [{ project_id: project.projectId }],
        rowCount: project === undefined ? 0 : 1,
      };
    }
    if (trimmed.startsWith("SELECT org_id FROM projects WHERE project_id = $1")) {
      const project = this.projects.get(String(params[0]));
      return {
        rows: project === undefined ? [] : [{ org_id: project.orgId }],
        rowCount: project === undefined ? 0 : 1,
      };
    }
    if (trimmed.startsWith("SELECT role FROM project_members")) {
      const projectId = String(params[0]);
      const userId = String(params[1]);
      const row = this.memberships.find((m) => m.projectId === projectId && m.userId === userId);
      return {
        rows: row === undefined ? [] : [{ role: row.role }],
        rowCount: row === undefined ? 0 : 1,
      };
    }
    if (trimmed.startsWith("SELECT spec_id FROM specs WHERE project_id = $1 AND spec_id = ANY")) {
      return { rows: [], rowCount: 0 };
    }
    if (trimmed.startsWith("INSERT INTO specs")) {
      this.specInserts.push({ sql: trimmed, params });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  async connect() {
    return this;
  }
  release() {}
  asPgPool() {
    return this as never;
  }
}

const ACTOR: ActorContext = {
  userId: "user_a",
  orgId: "org_1",
  projectId: null,
  scopes: ["org:member", "project:member"],
  source: "session",
};

function newPool(): CapturingPool {
  const pool = new CapturingPool();
  pool.projects.set("project_ra2", { projectId: "project_ra2", orgId: "org_1" });
  pool.memberships.push({ projectId: "project_ra2", userId: "user_a", role: "member" });
  return pool;
}

function baseInput(triageProvenance?: CreateSpecInput["triageProvenance"]): CreateSpecInput {
  return {
    projectId: "project_ra2",
    title: "routed",
    description: "auto-routed from triage",
    acceptanceCriteria: ["given the triaged finding, when the run re-drives, then the routed spec is picked up"],
    ...(triageProvenance !== undefined && { triageProvenance }),
  };
}

describe("createSpec — triage provenance ROUND-TRIP through INSERT INTO specs (Claude RA2)", () => {
  // The four provenance columns land in the INSERT's positional $11..$14 after
  // (spec_id, project_id, org_id, title, description, acceptance_criteria,
  //  depends_on, status, priority, mode). A regression that drops the fields
  // would strand a routed spec without any queryable origin.
  it("stamps parent_spec_id/source_finding_ids/origin_triage_task_id/origin_run_id in $11..$14", async () => {
    const pool = newPool();
    await createSpec(
      pool.asPgPool(),
      baseInput({
        parentSpecId: "spec_parent",
        sourceFindingIds: ["finding_1", "finding_2"],
        originTriageTaskId: "task_triage_a",
        originRunId: "run_source_a",
      }),
      ACTOR,
    );
    expect(pool.specInserts).toHaveLength(1);
    const insert = pool.specInserts[0]!;
    expect(insert.sql).toContain("parent_spec_id");
    expect(insert.sql).toContain("source_finding_ids");
    expect(insert.sql).toContain("origin_triage_task_id");
    expect(insert.sql).toContain("origin_run_id");
    // $11 = parent_spec_id
    expect(insert.params[10]).toBe("spec_parent");
    // $12 = source_finding_ids (text[])
    expect(insert.params[11]).toEqual(["finding_1", "finding_2"]);
    // $13 = origin_triage_task_id
    expect(insert.params[12]).toBe("task_triage_a");
    // $14 = origin_run_id
    expect(insert.params[13]).toBe("run_source_a");
  });

  // A non-routed spec (operator create / discovery accept / seed) leaves the
  // block off and every provenance column is null — matches the pre-migration
  // shape of the row and preserves the existing test surface.
  it("a spec created WITHOUT triageProvenance stamps null across $11..$14", async () => {
    const pool = newPool();
    await createSpec(pool.asPgPool(), baseInput(), ACTOR);
    expect(pool.specInserts).toHaveLength(1);
    const insert = pool.specInserts[0]!;
    expect(insert.params[10]).toBeNull();
    expect(insert.params[11]).toBeNull();
    expect(insert.params[12]).toBeNull();
    expect(insert.params[13]).toBeNull();
  });

  // An empty finding-ids array is preserved as an empty array (NOT null) — a
  // triaged item that carries a title but no explicit finding refs is still a
  // routed spec, and querying for the parent_spec_id must still find it.
  it("an empty sourceFindingIds array is preserved as [] (not null)", async () => {
    const pool = newPool();
    await createSpec(
      pool.asPgPool(),
      baseInput({
        parentSpecId: "spec_parent",
        sourceFindingIds: [],
        originTriageTaskId: "task_triage_a",
        originRunId: "run_source_a",
      }),
      ACTOR,
    );
    expect(pool.specInserts[0]!.params[11]).toEqual([]);
  });
});
