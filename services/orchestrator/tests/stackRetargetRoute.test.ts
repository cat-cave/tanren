// gv-4: callable HTTP for the transitive stack-retarget safety view.
// Exercises the real production resolveSpeculativeState construction path via
// the route (not only a pure helper).

import { Hono } from "hono";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createRunRoutes } from "../src/routes/runs/index.js";
import { StackRetargetView } from "../src/routes/runs/stackRetargetContract.js";

const alice: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

const member = (specId: string, branch: string) => ({
  specId,
  runId: `run_${specId}`,
  branch,
  headSha: "a".repeat(40),
});

/** Minimal pool that serves stack-retarget reads + project access. */
class StackRetargetPool {
  ancestorStack: unknown = null;
  mergedAncestors: string[] = [];
  defaultBranch = "main";
  runProjectId = "proj_1";
  runOrgId = "org_acme";
  /** When true, the run row is missing (404). */
  missingRun = false;
  /**
   * The project's org_id returned by the project-access gate. Default matches the path
   * org; a mismatch (or `projectMember = null`) denies project access → 403.
   */
  projectOrgId = "org_acme";
  /** A project_members row for the gate; `null` ⇒ no membership (denied). */
  projectMember: { user_id: string; role: string } | null = { user_id: "user_alice", role: "member" };
  /**
   * Counts entry reads from `resolveSpeculativeState` (the resolver's first query). A
   * denial MUST leave this at 0 — proving the resolver data was never invoked/read.
   */
  resolverReads = 0;

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    // project access gate (assertProjectAccess → projects + membership)
    if (sql.includes("FROM projects") && sql.includes("project_id")) {
      return {
        rows: [{ project_id: "proj_1", org_id: this.projectOrgId, name: "Apex", visibility: "private" }],
        rowCount: 1,
      };
    }
    if (sql.includes("project_members") || sql.includes("FROM project_memberships")) {
      if (this.projectMember === null) return { rows: [], rowCount: 0 };
      return { rows: [this.projectMember], rowCount: 1 };
    }
    if (sql.includes("SELECT r.run_id, r.project_id, r.org_id, p.default_branch")) {
      if (this.missingRun) return { rows: [], rowCount: 0 };
      if (params[0] !== "run_1" || params[1] !== "org_acme" || params[2] !== "proj_1") {
        return { rows: [], rowCount: 0 };
      }
      return {
        rows: [
          {
            run_id: "run_1",
            project_id: this.runProjectId,
            org_id: this.runOrgId,
            default_branch: this.defaultBranch,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.startsWith("SELECT ancestor_stack, spec_id, project_id FROM runs")) {
      // The resolver (`resolveSpeculativeState`) entry read — counts invocation so a
      // denial can prove the resolver data was never reached.
      this.resolverReads += 1;
      if (params[0] !== "run_1") return { rows: [], rowCount: 0 };
      return {
        rows: [{ ancestor_stack: this.ancestorStack, spec_id: "spec_child", project_id: "proj_1" }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM specs s") && sql.includes("status = 'merged'")) {
      const requested = Array.isArray(params[1]) ? new Set(params[1] as string[]) : null;
      const merged = this.mergedAncestors.filter((id) => requested === null || requested.has(id));
      return { rows: merged.map((spec_id) => ({ spec_id })), rowCount: merged.length };
    }
    // org scope / RLS bookkeeping queries — empty ok
    return { rows: [], rowCount: 0 };
  }

  async connect(): Promise<{
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
    release: () => void;
  }> {
    // runWithOrgScope acquires a client; forward to the same SQL mock.
    return {
      query: (sql, params) => this.query(sql, params ?? []),
      release: () => {},
    };
  }

  asPgPool(): Pool {
    return this as unknown as Pool;
  }
}

function buildHarness(pool: StackRetargetPool) {
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return alice;
        },
      } as never,
      localDevActor: alice,
    }),
  );
  app.route("/orgs", createRunRoutes({ pool: pool.asPgPool() }));
  return app;
}

describe("GET stack-retarget (gv-4)", () => {
  it("returns complete member vector + default_branch target when all stack members merged", async () => {
    const pool = new StackRetargetPool();
    pool.ancestorStack = [
      member("spec_a", "tanren/run_a"),
      member("spec_b", "tanren/run_b"),
      member("spec_c", "tanren/run_c"),
      member("spec_d", "tanren/run_d"),
      member("spec_e", "tanren/run_e"),
      member("spec_f", "tanren/run_f"),
    ];
    pool.mergedAncestors = ["spec_a", "spec_b", "spec_c", "spec_d", "spec_e", "spec_f"];
    const app = buildHarness(pool);

    const res = await app.request("/orgs/org_acme/projects/proj_1/runs/run_1/stack-retarget");
    expect(res.status).toBe(200);
    const body = StackRetargetView.parse(await res.json());
    expect(body.missionNodeId).toBe("gv-4");
    expect(body.speculative).toBe(true);
    expect(body.members).toHaveLength(6);
    expect(body.members.every((m) => m.merged)).toBe(true);
    expect(body.mergedSpecIds).toHaveLength(6);
    expect(body.unmergedAncestors).toEqual([]);
    expect(body.toBase).toBe("main");
    expect(body.remainingStack).toEqual([]);
    // Sanity: the resolver IS reached on the happy path — so a denial asserting
    // `resolverReads === 0` is a meaningful negative, not a tautology.
    expect(pool.resolverReads).toBeGreaterThan(0);
  });

  it("partial merge: unmerged tip is toBase; transitive merged members flagged", async () => {
    const pool = new StackRetargetPool();
    pool.ancestorStack = [
      member("spec_shared", "tanren/run_shared"),
      member("spec_left", "tanren/run_left"),
      member("spec_right", "tanren/run_right"),
    ];
    pool.mergedAncestors = ["spec_shared", "spec_left"];
    const app = buildHarness(pool);

    const res = await app.request("/orgs/org_acme/projects/proj_1/runs/run_1/stack-retarget");
    expect(res.status).toBe(200);
    const body = StackRetargetView.parse(await res.json());
    expect(body.toBase).toBe("tanren/run_right");
    expect(body.unmergedAncestors).toEqual(["spec_right"]);
    expect(body.remainingStack.map((m) => m.specId)).toEqual(["spec_right"]);
    expect(body.members.find((m) => m.specId === "spec_shared")?.merged).toBe(true);
  });

  it("non-speculative run: empty stack view with toBase = defaultBranch", async () => {
    const pool = new StackRetargetPool();
    pool.ancestorStack = [];
    const app = buildHarness(pool);

    const res = await app.request("/orgs/org_acme/projects/proj_1/runs/run_1/stack-retarget");
    expect(res.status).toBe(200);
    const body = StackRetargetView.parse(await res.json());
    expect(body.speculative).toBe(false);
    expect(body.members).toEqual([]);
    expect(body.toBase).toBe("main");
  });

  it("missing run → 404 run_not_found", async () => {
    const pool = new StackRetargetPool();
    pool.missingRun = true;
    const app = buildHarness(pool);

    const res = await app.request("/orgs/org_acme/projects/proj_1/runs/run_1/stack-retarget");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "run_not_found" });
  });

  it("NEGATIVE: denied org access → 403 and the resolver is never invoked", async () => {
    // alice is a member of org_acme; addressing a different org fails the pure org gate
    // BEFORE any pool query. The resolver data is never read.
    const pool = new StackRetargetPool();
    pool.ancestorStack = [member("spec_a", "tanren/run_a")];
    const app = buildHarness(pool);

    const res = await app.request("/orgs/org_other/projects/proj_1/runs/run_1/stack-retarget");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "org_access_denied" });
    expect(pool.resolverReads).toBe(0);
  });

  it("NEGATIVE: denied project access → 403 and the resolver is never invoked", async () => {
    // Org access to org_acme is granted, but the project belongs to a different org
    // (project/Org mismatch) AND the actor is not a project member → assertProjectAccess
    // throws ToolAccessDeniedError → 403 before the resolver runs. The existing
    // org-scoped/RLS route construction (`runWithOrgScope`) is untouched.
    const pool = new StackRetargetPool();
    // Project not in the path org; alice isn't a member → project access denied.
    pool.projectOrgId = "org_other";
    pool.projectMember = null;
    pool.ancestorStack = [member("spec_a", "tanren/run_a")];
    const app = buildHarness(pool);

    const res = await app.request("/orgs/org_acme/projects/proj_1/runs/run_1/stack-retarget");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({ error: "project_access_denied" });
    expect(pool.resolverReads).toBe(0);
  });
});
