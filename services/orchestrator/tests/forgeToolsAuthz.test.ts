// Mutation ratchet (test/mutation-ratchet-forge): behavior-based coverage of the
// Forge tool AUTHZ gate (tools/authz.ts) and the WRITE tool surface
// (tools/write.ts). authz.ts was at 49% and write.ts at 13% in the cluster
// baseline because the grant/deny branches (platform admin, project member,
// same-org member, missing project/run/spec) were never exhaustively asserted.
//
// Every test drives the real authz functions through an in-memory pg substitute
// that returns the SQL shapes the gate queries, and asserts the OBSERVABLE
// outcome: a returned orgId/projectId on grant, or a typed ToolAccessDeniedError
// on denial. No mocks, no spy-call assertions.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import {
  assertProjectAccess,
  assertRunAccess,
  assertSpecAccess,
  ToolAccessDeniedError,
} from "../src/engine/forge/tools/authz.js";
import {
  tanrenAcknowledgeInsight,
  tanrenRerunTask,
  peekAcknowledgedInsightForTests,
  WriteToolAccessDeniedError,
} from "../src/engine/forge/index.js";

// A focused pg substitute for the authz gate: it answers exactly the four
// SELECTs authz.ts emits (project org, project_members, runs, specs). Each
// table can be seeded so a test can express the precise reachability scenario.
class AuthzPool {
  projects = new Map<string, { org_id: string | null }>();
  projectMembers = new Set<string>();
  runs = new Map<string, { project_id: string; spec_id: string }>();
  specs = new Map<string, { project_id: string }>();

  async query(sql: string, params: ReadonlyArray<unknown> = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const t = sql.trim();
    if (t.startsWith("SELECT org_id FROM projects")) {
      const p = this.projects.get(String(params[0]));
      return p === undefined ? { rows: [], rowCount: 0 } : { rows: [{ org_id: p.org_id }], rowCount: 1 };
    }
    if (t.startsWith("SELECT role FROM project_members")) {
      const has = this.projectMembers.has(`${String(params[0])}:${String(params[1])}`);
      return has ? { rows: [{ role: "member" }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (t.startsWith("SELECT project_id, spec_id FROM runs")) {
      const r = this.runs.get(String(params[0]));
      return r === undefined ? { rows: [], rowCount: 0 } : { rows: [r], rowCount: 1 };
    }
    if (t.startsWith("SELECT project_id FROM specs")) {
      const s = this.specs.get(String(params[0]));
      return s === undefined ? { rows: [], rowCount: 0 } : { rows: [{ project_id: s.project_id }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  asPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }
}

const projectMember: ActorContext = {
  userId: "user_pm",
  orgId: "org_a",
  projectId: "project_a",
  scopes: ["project:member"],
  source: "session",
};
const orgMember: ActorContext = {
  userId: "user_om",
  orgId: "org_a",
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};
const platformAdmin: ActorContext = {
  userId: "user_pa",
  orgId: "org_z",
  projectId: null,
  scopes: ["platform:admin"],
  source: "session",
};
const stranger: ActorContext = {
  userId: "user_x",
  orgId: "org_b",
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

describe("assertProjectAccess", () => {
  it("grants and returns the orgId for a direct project member", async () => {
    const p = new AuthzPool();
    p.projects.set("project_a", { org_id: "org_a" });
    p.projectMembers.add("project_a:user_pm");
    const result = await assertProjectAccess(p.asPool(), "project_a", projectMember);
    expect(result).toEqual({ orgId: "org_a" });
  });

  it("grants a platform admin without requiring membership", async () => {
    const p = new AuthzPool();
    p.projects.set("project_a", { org_id: "org_a" });
    // No membership rows seeded; the admin scope alone grants.
    const result = await assertProjectAccess(p.asPool(), "project_a", platformAdmin);
    expect(result).toEqual({ orgId: "org_a" });
  });

  it("grants a same-org org:member who is not a direct project member", async () => {
    const p = new AuthzPool();
    p.projects.set("project_a", { org_id: "org_a" });
    const result = await assertProjectAccess(p.asPool(), "project_a", orgMember);
    expect(result).toEqual({ orgId: "org_a" });
  });

  it("grants a same-org org:admin (the org:admin arm of the scope check)", async () => {
    const p = new AuthzPool();
    p.projects.set("project_a", { org_id: "org_a" });
    const orgAdmin: ActorContext = { ...orgMember, userId: "user_oa", scopes: ["org:admin"] };
    const result = await assertProjectAccess(p.asPool(), "project_a", orgAdmin);
    expect(result).toEqual({ orgId: "org_a" });
  });

  it("denies an org:member whose org differs from the project's org, naming the project", async () => {
    const p = new AuthzPool();
    p.projects.set("project_a", { org_id: "org_a" });
    const err = await assertProjectAccess(p.asPool(), "project_a", stranger).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolAccessDeniedError);
    expect((err as Error).message).toContain("project_a");
  });

  it("denies access to a project with no resolvable org (no null-org bypass)", async () => {
    const p = new AuthzPool();
    p.projects.set("project_a", { org_id: null });
    await expect(assertProjectAccess(p.asPool(), "project_a", platformAdmin)).rejects.toBeInstanceOf(
      ToolAccessDeniedError,
    );
  });

  it("denies access to a missing project", async () => {
    const p = new AuthzPool();
    await expect(assertProjectAccess(p.asPool(), "project_missing", projectMember)).rejects.toBeInstanceOf(
      ToolAccessDeniedError,
    );
  });

  it("denies a no-scope actor of the right org (membership AND scope both required)", async () => {
    const p = new AuthzPool();
    p.projects.set("project_a", { org_id: "org_a" });
    const noScope: ActorContext = { ...orgMember, scopes: [] };
    await expect(assertProjectAccess(p.asPool(), "project_a", noScope)).rejects.toBeInstanceOf(ToolAccessDeniedError);
  });
});

describe("assertRunAccess", () => {
  it("returns the run's project + spec when the actor can reach the project", async () => {
    const p = new AuthzPool();
    p.projects.set("project_a", { org_id: "org_a" });
    p.runs.set("run_1", { project_id: "project_a", spec_id: "spec_1" });
    const result = await assertRunAccess(p.asPool(), "run_1", orgMember);
    expect(result).toEqual({ projectId: "project_a", specId: "spec_1" });
  });

  it("throws a 'run not found' error naming the run id for a missing run", async () => {
    const p = new AuthzPool();
    const err = await assertRunAccess(p.asPool(), "run_missing", orgMember).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolAccessDeniedError);
    expect((err as Error).message).toContain("run not found: run_missing");
  });

  it("denies a run whose project the actor cannot reach", async () => {
    const p = new AuthzPool();
    p.projects.set("project_a", { org_id: "org_a" });
    p.runs.set("run_1", { project_id: "project_a", spec_id: "spec_1" });
    await expect(assertRunAccess(p.asPool(), "run_1", stranger)).rejects.toBeInstanceOf(ToolAccessDeniedError);
  });
});

describe("assertSpecAccess", () => {
  it("returns the spec's project when the actor can reach it", async () => {
    const p = new AuthzPool();
    p.projects.set("project_a", { org_id: "org_a" });
    p.specs.set("spec_1", { project_id: "project_a" });
    const result = await assertSpecAccess(p.asPool(), "spec_1", orgMember);
    expect(result).toEqual({ projectId: "project_a" });
  });

  it("throws a 'spec not found' error naming the spec id for a missing spec", async () => {
    const p = new AuthzPool();
    const err = await assertSpecAccess(p.asPool(), "spec_missing", orgMember).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolAccessDeniedError);
    expect((err as Error).message).toContain("spec not found: spec_missing");
  });

  it("denies a spec whose project the actor cannot reach", async () => {
    const p = new AuthzPool();
    p.projects.set("project_a", { org_id: "org_a" });
    p.specs.set("spec_1", { project_id: "project_a" });
    await expect(assertSpecAccess(p.asPool(), "spec_1", stranger)).rejects.toBeInstanceOf(ToolAccessDeniedError);
  });
});

describe("tanrenRerunTask", () => {
  // A pg substitute that answers the task→spec join the rerun tool issues.
  class RerunPool {
    tasks = new Map<string, string>(); // task_id -> spec_id
    async query(sql: string, params: ReadonlyArray<unknown> = []): Promise<{ rows: unknown[]; rowCount: number }> {
      if (sql.includes("FROM tasks t") && sql.includes("INNER JOIN runs r")) {
        const specId = this.tasks.get(String(params[0]));
        return specId === undefined ? { rows: [], rowCount: 0 } : { rows: [{ spec_id: specId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    asPool(): pg.Pool {
      return this as unknown as pg.Pool;
    }
  }

  it("throws WriteToolAccessDeniedError naming the task when the task is unknown", async () => {
    const p = new RerunPool();
    await expect(tanrenRerunTask({ pool: p.asPool() }, { taskId: "task_missing" }, projectMember)).rejects.toThrowError(
      /task not found: task_missing/u,
    );
    await expect(
      tanrenRerunTask({ pool: p.asPool() }, { taskId: "task_missing" }, projectMember),
    ).rejects.toBeInstanceOf(WriteToolAccessDeniedError);
  });
});

describe("tanrenAcknowledgeInsight (in-memory mirror)", () => {
  // A pg substitute where the acknowledge write touches no cache row, so the
  // persisted flag is false but the in-memory mirror still records the ack.
  class AckPool {
    async query(): Promise<{ rows: unknown[]; rowCount: number }> {
      return { rows: [], rowCount: 0 };
    }
    asPool(): pg.Pool {
      return this as unknown as pg.Pool;
    }
  }

  it("records the acknowledging operator in the mirror and reports persisted=false with no cache row", async () => {
    const p = new AckPool();
    const insightId = `insight_ratchet_${Math.random().toString(36).slice(2)}`;
    const result = await tanrenAcknowledgeInsight({ pool: p.asPool() }, { insightId }, projectMember);
    expect(result.insightId).toBe(insightId);
    expect(result.acknowledgedBy).toBe("user_pm");
    expect(result.persisted).toBe(false);
    // The mirror records the same actor + the same timestamp the result carries.
    const mirrored = peekAcknowledgedInsightForTests(insightId);
    expect(mirrored?.acknowledgedBy).toBe("user_pm");
    expect(mirrored?.acknowledgedAt).toEqual(result.acknowledgedAt);
  });
});
