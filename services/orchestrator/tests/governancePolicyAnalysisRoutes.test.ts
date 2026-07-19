// gv-13 — route tests driving the REAL governance HTTP seam (createGovernanceRoutes)
// for policy validate / simulate / explain. Covers the required contradiction-witness
// case (422 + unresolvedReferences) and validate-error case (400 malformed), plus the
// fail-closed guarantee that a contradictory policy cannot simulate to an allow.

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { createGovernanceRoutes } from "../src/routes/governance/index.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { RoutesPool } from "./helpers/routesPool.js";

const admin: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member", "org:admin"],
  source: "session",
};

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiVersion: "tanren.dev/governance/v2",
    schemaVersion: 1,
    core: {
      rules: [
        { key: "review.mode", value: "human" },
        { key: "review.minimum_approvals", value: 2 },
        { key: "audit.block_at", value: "P2" },
      ],
    },
    org: { rules: [] },
    tier: { rules: [] },
    binding: { rules: [] },
    ...overrides,
  };
}

// A policy whose EFFECTIVE review mode is auto in every layer — the precondition
// for the auto-mode contradiction classes.
function autoBase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return base({
    core: {
      rules: [
        { key: "review.mode", value: "auto" },
        { key: "review.minimum_approvals", value: 0 },
      ],
    },
    ...overrides,
  });
}

const scenario = {
  repositoryVisibility: "private",
  review: {
    mode: "human",
    approvals: 2,
    approvingPrincipals: [],
    freshness: "exact_head_sha",
    forgePublished: true,
    dismissedStaleOnBaseShift: true,
  },
  audit: { highestOpenSeverity: "none", residualDisposition: "human_required" },
  integration: { unmergedAncestorDepth: 0, baseShiftRegated: true },
  budget: { monthlySpendUsd: 10, perSpecSpendUsd: 5, unknownCostEncountered: false },
  notifications: { acknowledged: 3 },
  coverage: { evidenceAgeDays: 1 },
};

function buildHarness(boundActor: ActorContext = admin) {
  const pool = new RoutesPool();
  pool.seedOrg({ id: "org_acme" });
  pool.seedMembership("org_acme", boundActor.userId, boundActor.scopes.includes("org:admin") ? "admin" : "member");
  pool.seedProject({ project_id: "proj_1", org_id: "org_acme", config: { version: 1 } });

  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return boundActor;
        },
      } as never,
      localDevActor: boundActor,
    }),
  );
  app.route("/orgs", createGovernanceRoutes({ pool: pool.asPgPool() }));
  return app;
}

async function post(app: Hono<ActorContextEnv>, path: string, body: unknown) {
  const res = await app.request(`/orgs/org_acme/projects/proj_1/governance/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> };
}

describe("gv-13 governance policy analysis routes", () => {
  it("validate: a well-formed satisfiable policy returns 200 valid", async () => {
    const app = buildHarness();
    const { status, body } = await post(app, "policy/validate", { sourceDocument: base() });
    expect(status).toBe(200);
    expect((body.report as { status: string }).status).toBe("valid");
  });

  it("validate-error: a malformed policy (unknown key) returns 400 malformed", async () => {
    const app = buildHarness();
    const { status, body } = await post(app, "policy/validate", {
      sourceDocument: base({ core: { rules: [{ key: "bogus.key", value: 1 }] } }),
    });
    expect(status).toBe(400);
    expect((body.report as { status: string }).status).toBe("malformed");
  });

  it("validate: auto review + required principal returns 422 with witnesses + unresolvedReferences", async () => {
    const app = buildHarness();
    const { status, body } = await post(app, "policy/validate", {
      sourceDocument: autoBase({
        binding: { rules: [{ key: "review.required_principal", value: { kind: "user", name: "auditor" } }] },
      }),
    });
    expect(status).toBe(422);
    const report = body.report as {
      status: string;
      contradictionWitnesses: { kind: string }[];
      unresolvedReferences: unknown[];
    };
    expect(report.status).toBe("contradictory");
    expect(report.contradictionWitnesses.map((w) => w.kind)).toContain("automatic_review_forbids_required_principal");
    expect(report.unresolvedReferences).toEqual([{ kind: "user", name: "auditor", source: undefined }]);
  });

  it("simulate: a compliant scenario returns 200 allowed", async () => {
    const app = buildHarness();
    const { status, body } = await post(app, "policy/simulate", { sourceDocument: base(), input: scenario });
    expect(status).toBe(200);
    expect((body.simulation as { decision: string }).decision).toBe("allowed");
  });

  it("simulate: too few approvals returns 200 blocked with the violating rule", async () => {
    const app = buildHarness();
    const { status, body } = await post(app, "policy/simulate", {
      sourceDocument: base(),
      input: { ...scenario, review: { ...scenario.review, approvals: 0 } },
    });
    expect(status).toBe(200);
    const sim = body.simulation as { decision: string; violations: { key: string }[] };
    expect(sim.decision).toBe("blocked");
    expect(sim.violations.map((v) => v.key)).toContain("review.minimum_approvals");
  });

  it("simulate FAIL-CLOSED: a contradictory policy returns 422, never an allow", async () => {
    const app = buildHarness();
    const { status, body } = await post(app, "policy/simulate", {
      sourceDocument: autoBase({
        core: {
          rules: [
            { key: "review.mode", value: "auto" },
            { key: "review.minimum_approvals", value: 2 },
          ],
        },
      }),
      input: scenario,
    });
    expect(status).toBe(422);
    expect(body.error).toBe("policy_contradictory");
  });

  it("simulate: an incoherent hypothetical (auto mode with approvals) is rejected 400", async () => {
    const app = buildHarness();
    const { status, body } = await post(app, "policy/simulate", {
      sourceDocument: base(),
      input: { ...scenario, review: { ...scenario.review, mode: "auto", approvals: 3 } },
    });
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_simulation_input");
  });

  it("explain: returns 200 with a human-readable rationale + provenance", async () => {
    const app = buildHarness();
    const { status, body } = await post(app, "policy/explain", {
      sourceDocument: base(),
      input: { ...scenario, review: { ...scenario.review, approvals: 0 } },
    });
    expect(status).toBe(200);
    const explanation = body.explanation as { decision: string; headline: string; rationale: string[] };
    expect(explanation.decision).toBe("blocked");
    expect(explanation.rationale.some((line) => line.includes("review.minimum_approvals"))).toBe(true);
  });

  it("explain: a contradictory policy returns 422 with concrete witness proofs", async () => {
    const app = buildHarness();
    const { status, body } = await post(app, "policy/explain", {
      sourceDocument: autoBase({
        core: {
          rules: [
            { key: "review.mode", value: "auto" },
            { key: "review.minimum_approvals", value: 2 },
          ],
        },
      }),
      input: scenario,
    });
    expect(status).toBe(422);
    const proofs = body.witnessProofs as { witness: { kind: string }; inputA: unknown; inputB: unknown }[];
    expect(proofs.length).toBeGreaterThan(0);
    expect(proofs[0]?.inputA).toBeDefined();
    expect(proofs[0]?.inputB).toBeDefined();
  });

  it("denies a foreign org (403)", async () => {
    const app = buildHarness();
    const res = await app.request("/orgs/org_other/projects/proj_1/governance/policy/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceDocument: base() }),
    });
    expect(res.status).toBe(403);
  });
});
