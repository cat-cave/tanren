// P1b (autonomy-engine.md §1b): an explicit spec priority is persisted at create
// time, both on the returned contract AND the stored row the DagWalker's read
// model later orders by. The default-priority (`tbd`) case is asserted in
// projectSpecWorkflow.test.ts; this file pins the explicit-priority path through
// the real `createSpec` engine (via the in-memory contract pool below).

import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { createProject, createSpec } from "../src/engine/workflow/projectSpec.js";

// A minimal in-memory pool: it answers the exact statements `createProject` +
// `createSpec` issue and records the persisted spec's bound `priority` param
// (the 8th INSERT bind). It is a TEST FIXTURE (lives under tests/), never wired
// into src/.
class PriorityPool {
  private readonly projects = new Set<string>();
  readonly specs = new Map<string, { priority: string }>();

  async query(text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.startsWith("SET LOCAL")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("INSERT INTO projects")) {
      this.projects.add(String(params[0]));
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO project_members")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT project_id FROM projects")) {
      const id = String(params[0]);
      return this.projects.has(id) ? { rows: [{ project_id: id }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    // v68 fix: createSpec calls loadProjectOrgId for the spec's NOT NULL org_id.
    if (sql.startsWith("SELECT org_id FROM projects")) {
      const id = String(params[0]);
      return this.projects.has(id) ? { rows: [{ org_id: "org_p1b" }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("INSERT INTO specs")) {
      // params[8] is the `priority` bind (v68 fix: org_id at $3 shifts +1).
      this.specs.set(String(params[0]), { priority: String(params[8]) });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  async connect(): Promise<PriorityPool> {
    return this;
  }
  release(): void {}
  asPgPool() {
    return this as never;
  }
}

const actor: ActorContext = {
  userId: "user_p1b",
  orgId: "org_p1b",
  projectId: null,
  scopes: ["platform:admin"],
  source: "local_dev",
};

describe("createSpec · priority persistence (§1b)", () => {
  it("persists an explicit priority on the created spec, contract + row", async () => {
    const pool = new PriorityPool();
    const project = await createProject(
      pool.asPgPool(),
      { name: "Tanren", repoUrl: "https://example.test/repo", config: { version: 1 } },
      actor,
    );

    const spec = await createSpec(
      pool.asPgPool(),
      {
        projectId: project.projectId,
        title: "Urgent fix",
        description: "A P0 the walker must schedule first",
        acceptanceCriteria: ["It works"],
        priority: "P0",
      },
      actor,
    );

    expect(spec.priority).toBe("P0");
    expect(pool.specs.get(spec.specId)?.priority).toBe("P0");
  });

  it("defaults to tbd when no priority is supplied", async () => {
    const pool = new PriorityPool();
    const project = await createProject(
      pool.asPgPool(),
      { name: "Tanren", repoUrl: "https://example.test/repo", config: { version: 1 } },
      actor,
    );
    const spec = await createSpec(
      pool.asPgPool(),
      {
        projectId: project.projectId,
        title: "Backlog item",
        description: "no triage yet",
        acceptanceCriteria: ["done"],
      },
      actor,
    );
    expect(spec.priority).toBe("tbd");
    expect(pool.specs.get(spec.specId)?.priority).toBe("tbd");
  });
});
