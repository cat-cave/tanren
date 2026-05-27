import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/index.js";
import { createSpec, ProjectAccessDeniedError } from "../src/engine/workflow/projectSpec.js";

interface ProjectRow {
  projectId: string;
  orgId: string | null;
}

interface MemberRow {
  projectId: string;
  userId: string;
  role: string;
}

class ScopingPool {
  readonly projects = new Map<string, ProjectRow>();
  readonly projectMembers: MemberRow[] = [];
  readonly specs: unknown[] = [];

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const trimmed = sql.trim();
    if (trimmed.startsWith("SELECT project_id FROM projects WHERE project_id = $1")) {
      const project = this.projects.get(String(params[0]));
      return {
        rows: project === undefined ? [] : [{ project_id: project.projectId }],
        rowCount: project === undefined ? 0 : 1
      };
    }
    if (trimmed.startsWith("SELECT org_id FROM projects WHERE project_id = $1")) {
      const project = this.projects.get(String(params[0]));
      return {
        rows: project === undefined ? [] : [{ org_id: project.orgId }],
        rowCount: project === undefined ? 0 : 1
      };
    }
    if (trimmed.startsWith("SELECT role FROM project_members")) {
      const projectId = String(params[0]);
      const userId = String(params[1]);
      const row = this.projectMembers.find((m) => m.projectId === projectId && m.userId === userId);
      return { rows: row === undefined ? [] : [{ role: row.role }], rowCount: row === undefined ? 0 : 1 };
    }
    if (trimmed.startsWith("SELECT spec_id FROM specs WHERE project_id = $1 AND spec_id = ANY")) {
      return { rows: [], rowCount: 0 };
    }
    if (trimmed.startsWith("INSERT INTO specs")) {
      this.specs.push(params);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  // pg.Pool shape stubs
  async connect() {
    return this;
  }
  release() {}
  asPgPool() {
    return this as never;
  }
}

const baseActor = (overrides: Partial<ActorContext>): ActorContext => ({
  userId: "user_x",
  orgId: null,
  projectId: null,
  scopes: [],
  source: "session",
  ...overrides
});

describe("project scoping by actor context", () => {
  it("allows a project-member actor to create a spec", async () => {
    const pool = new ScopingPool();
    pool.projects.set("project_a", { projectId: "project_a", orgId: "org_1" });
    pool.projectMembers.push({ projectId: "project_a", userId: "user_a", role: "member" });
    const actor = baseActor({ userId: "user_a", orgId: "org_1", scopes: ["org:member", "project:member"] });
    await expect(
      createSpec(
        pool.asPgPool(),
        { projectId: "project_a", title: "t", description: "d", acceptanceCriteria: ["a"] },
        actor
      )
    ).resolves.toMatchObject({ projectId: "project_a" });
  });

  it("denies a cross-org actor with ProjectAccessDeniedError", async () => {
    const pool = new ScopingPool();
    pool.projects.set("project_a", { projectId: "project_a", orgId: "org_1" });
    const actor = baseActor({ userId: "user_b", orgId: "org_2", scopes: ["org:member"] });
    await expect(
      createSpec(
        pool.asPgPool(),
        { projectId: "project_a", title: "t", description: "d", acceptanceCriteria: ["a"] },
        actor
      )
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError);
  });

  it("permits an org-member actor via the org fallback when the project belongs to their org", async () => {
    const pool = new ScopingPool();
    pool.projects.set("project_a", { projectId: "project_a", orgId: "org_1" });
    const actor = baseActor({ userId: "user_a", orgId: "org_1", scopes: ["org:member"] });
    await expect(
      createSpec(
        pool.asPgPool(),
        { projectId: "project_a", title: "t", description: "d", acceptanceCriteria: ["a"] },
        actor
      )
    ).resolves.toBeDefined();
  });

  it("platform:admin bypasses all scoping checks", async () => {
    const pool = new ScopingPool();
    pool.projects.set("project_a", { projectId: "project_a", orgId: "org_1" });
    const actor = baseActor({ userId: "user_root", orgId: null, scopes: ["platform:admin"] });
    await expect(
      createSpec(
        pool.asPgPool(),
        { projectId: "project_a", title: "t", description: "d", acceptanceCriteria: ["a"] },
        actor
      )
    ).resolves.toBeDefined();
  });
});
