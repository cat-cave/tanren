// in-5: the requirement-compiler ROUTE test — proves the prod WIRING (trap #2
// fake-masks-prod guard) without a real Postgres. A minimal fake pool routes the
// three store SQLs (spec select / contract select / requirement insert) so the
// real `runWithOrgScope` + the real stores run end-to-end; the answerer factory
// is faked at the ACTOR seam (the route receives a `RequirementCompilerActor`),
// and a fake event store captures the emits.
//
// Asserts the wiring:
//   - the route loads the spec + contract via the REAL stores (SQL through the fake pool)
//   - the route invokes the actor (the compile seam) with the loaded context
//   - the route persists via the REAL IntegrationRequirementStore (INSERT through the fake pool)
//   - the route emits `integration.requirement.derived` per persisted row
//   - 404 on a missing spec, 409 on a missing contract, 502 on a malformed LLM result,
//     403 on an off-scope actor
import { describe, expect, it } from "vitest";
import { Hono } from "hono";

import type { pg } from "pg";
import type { ActorContext } from "../src/auth/schemas.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createRequirementCompilerRoutes } from "../src/routes/requirementCompiler/index.js";
import type { EventStore } from "../src/engine/eventStore.js";
import type { RequirementCompilerActor } from "../src/engine/workflow/requirementCompiler/requirementCompiler.js";
import { MalformedRequirementCompilerResultError } from "../src/engine/workflow/requirementCompiler/requirementCompiler.js";
import { goldenProductMessagingRequirement } from "../src/engine/contracts/integrationRequirement.js";

interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

interface FakeSpec {
  spec_id: string;
  project_id: string;
  title: string;
  description: string;
  acceptance_criteria: unknown[];
  depends_on: unknown[];
  status: string;
  priority: string;
  org_id: string;
}

interface FakeContract {
  id: string;
  org_id: string;
  project_id: string;
  version: number;
  domain: string;
  contract: unknown;
}

/**
 * A minimal fake pool that satisfies `runWithOrgScope` (connect/release/BEGIN/COMMIT)
 * AND routes the three store SQLs the requirement-compiler route issues. The SQL
 * matchers are deliberately LOOSE (prefix/text match) so a store-SQL refactor does
 * not silently break the wiring assertion — a miss returns an empty result, which
 * surfaces as the route's typed 404/409 path.
 */
class RequirementCompilerPool {
  readonly specs = new Map<string, FakeSpec>();
  readonly contracts = new Map<string, FakeContract>();
  readonly insertedRequirements: Record<string, unknown>[] = [];

  seedSpec(spec: FakeSpec): void {
    this.specs.set(spec.spec_id, spec);
  }
  seedContract(contract: FakeContract): void {
    this.contracts.set(contract.project_id, contract);
  }

  async connect(): Promise<RequirementCompilerPool> {
    return this;
  }
  release(): void {}

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const text = sql.trim();
    // Transaction control — no-op (runWithOrgScope issues these).
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (text.startsWith("SET LOCAL")) return { rows: [], rowCount: 0 };
    if (text.startsWith("SELECT pg_advisory_")) return { rows: [{}], rowCount: 1 };

    // SpecStore.get: SELECT spec_id, ... FROM specs WHERE spec_id = $1
    if (text.startsWith("SELECT") && text.includes("FROM specs") && text.includes("WHERE spec_id")) {
      const specId = String(params[0]);
      const row = this.specs.get(specId);
      return row === undefined ? { rows: [], rowCount: 0 } : { rows: [row], rowCount: 1 };
    }

    // DesignContractStore.getLatestState: SELECT id, ... FROM design_contracts WHERE project_id = $1 ORDER BY version DESC LIMIT 1
    if (text.startsWith("SELECT") && text.includes("FROM design_contracts") && text.includes("ORDER BY version DESC")) {
      const projectId = String(params[0]);
      const row = this.contracts.get(projectId);
      return row === undefined ? { rows: [], rowCount: 0 } : { rows: [row], rowCount: 1 };
    }

    // IntegrationRequirementStore.compile: INSERT INTO integration_requirements ...
    if (text.startsWith("INSERT INTO integration_requirements")) {
      // The real DB parses the `$7::jsonb` parameter back to an object; the fake
      // must match so `decodeRow`'s `parseIntegrationRequirement` sees an object.
      const desiredState = typeof params[6] === "string" ? JSON.parse(params[6] as string) : params[6];
      const id = String(params[1]);
      const capability = String(params[3]);
      const plane = String(params[4]);
      const direction = String(params[5]);
      const sourceRevisionId = String(params[7]);
      const sourceDigest = String(params[8]);
      const policyVersion = String(params[9]);
      const criticality = String(params[10]);
      const row: Record<string, unknown> = {
        id,
        project_id: params[2],
        capability,
        plane,
        direction,
        criticality,
        source_kind: "design_contract",
        source_revision_id: sourceRevisionId,
        source_digest: sourceDigest,
        policy_version: policyVersion,
        status: "active",
        desired_state: desiredState,
        created_at: new Date().toISOString(),
      };
      this.insertedRequirements.push(row);
      return { rows: [row], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  }

  asPgPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }
}

/** A fake event store capturing every append (for wiring assertions). */
class FakeEventStore implements EventStore {
  readonly appends: { eventType: string; payload: Record<string, unknown> }[] = [];
  async append(input: { eventType: string; payload: Record<string, unknown> }): Promise<void> {
    this.appends.push({ eventType: input.eventType, payload: input.payload });
  }
}

function buildHarness(opts: {
  pool: RequirementCompilerPool;
  actor: ActorContext;
  actorFactory: (target: { orgId: string; projectId: string }) => RequirementCompilerActor;
  eventStore?: EventStore;
}): { app: Hono<ActorContextEnv>; events: FakeEventStore } {
  const events = new FakeEventStore();
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return opts.actor;
        },
      } as never,
      localDevActor: opts.actor,
    }),
  );
  app.route(
    "/orgs",
    createRequirementCompilerRoutes({
      pool: opts.pool.asPgPool(),
      answererFactory: opts.actorFactory,
      eventStore: opts.eventStore ?? events,
    }),
  );
  return { app, events };
}

const ORG = "org_rc";
const PROJECT = "proj_rc";
const SPEC = "spec_rc";
const actor: ActorContext = {
  userId: "user_rc",
  orgId: ORG,
  projectId: null,
  scopes: ["org:admin"],
  source: "session",
};

function seedSpec(pool: RequirementCompilerPool): void {
  pool.seedSpec({
    spec_id: SPEC,
    project_id: PROJECT,
    title: "Celebrate 100 clicks",
    description: "Post a Slack message when a short link hits 100 clicks",
    acceptance_criteria: [
      "Given a short link with 99 clicks, when the 100th click is recorded, then a Slack message is posted",
    ],
    depends_on: [],
    status: "open",
    priority: "P2",
    org_id: ORG,
  });
}

function seedContract(pool: RequirementCompilerPool): void {
  pool.seedContract({
    id: "design_001",
    org_id: ORG,
    project_id: PROJECT,
    version: 1,
    domain: "link-shortener",
    contract: {
      version: 1,
      domain: "link-shortener",
      identity: "A product that shortens URLs",
      intent: "Shorten links and notify on milestones",
      principles: [],
      constraints: [],
      accessibilityPosture: { standard: "none", notes: "" },
      personaRefs: [],
      behaviorRefs: [],
      dimensions: [],
    },
  });
}

/** A fake actor that returns a canned compile result (exercises the route's persist + emit wiring). */
function fakeActorReturning(requirements: unknown[], rationale: string): RequirementCompilerActor {
  return {
    async compile() {
      // The real actor validates via parseIntegrationRequirement; the fake returns
      // pre-validated requirements so the route's persist + emit wiring is exercised
      // without a real LLM call. The STAGE test covers the validation path.
      const { parseIntegrationRequirement } = await import("../src/engine/contracts/integrationRequirement.js");
      const validated = requirements.map((r) => {
        const v = parseIntegrationRequirement(r);
        if (!v.ok) throw new Error(`fake actor fixture: invalid requirement: ${JSON.stringify(v.issues)}`);
        return v.requirement;
      });
      const { integrationRequirementDigest } = await import("../src/engine/contracts/integrationRequirement.js");
      return {
        requirements: validated,
        rationale,
        digests: validated.map((req) => integrationRequirementDigest(req)),
      };
    },
  };
}

describe("requirement compiler route — wiring", () => {
  it("happy path: compiles, persists, and emits integration.requirement.derived per requirement", async () => {
    const pool = new RequirementCompilerPool();
    seedSpec(pool);
    seedContract(pool);
    const golden = goldenProductMessagingRequirement();
    const { app, events } = buildHarness({
      pool,
      actor,
      actorFactory: () => fakeActorReturning([golden], "messaging implied by 100-click criterion"),
    });

    const response = await app.request(
      `/orgs/${ORG}/projects/${PROJECT}/specs/${SPEC}/compile-integration-requirements`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.missionNodeId).toBe("in-5");
    expect(body.requirementCount).toBe(1);
    expect(body.requirements[0].capability).toBe(golden.capability);

    // The store received the INSERT (wiring: route → IntegrationRequirementStore.compile).
    expect(pool.insertedRequirements).toHaveLength(1);
    expect(pool.insertedRequirements[0]!.capability).toBe(golden.capability);

    // The event store received `integration.requirement.derived` (wiring: route → eventStore).
    expect(events.appends).toHaveLength(1);
    expect(events.appends[0]!.eventType).toBe("integration.requirement.derived");
    expect(events.appends[0]!.payload.capability).toBe(golden.capability);
    expect(events.appends[0]!.payload.sourceKind).toBe("design_contract");
  });

  it("404 when the spec does not exist (no orphan persist)", async () => {
    const pool = new RequirementCompilerPool();
    // No spec seeded.
    seedContract(pool);
    const { app, events } = buildHarness({
      pool,
      actor,
      actorFactory: () => fakeActorReturning([], "none"),
    });
    const response = await app.request(
      `/orgs/${ORG}/projects/${PROJECT}/specs/${SPEC}/compile-integration-requirements`,
      { method: "POST" },
    );
    expect(response.status).toBe(404);
    expect(pool.insertedRequirements).toHaveLength(0);
    expect(events.appends).toHaveLength(0);
  });

  it("404 when the spec exists but belongs to a different project (no cross-project leak)", async () => {
    const pool = new RequirementCompilerPool();
    pool.seedSpec({
      spec_id: SPEC,
      project_id: "other_project",
      title: "T",
      description: "D",
      acceptance_criteria: [],
      depends_on: [],
      status: "open",
      priority: "P2",
      org_id: ORG,
    });
    seedContract(pool);
    const { app } = buildHarness({
      pool,
      actor,
      actorFactory: () => fakeActorReturning([], "none"),
    });
    const response = await app.request(
      `/orgs/${ORG}/projects/${PROJECT}/specs/${SPEC}/compile-integration-requirements`,
      { method: "POST" },
    );
    expect(response.status).toBe(404);
  });

  it("409 when the project has no DesignContract (compile requires design intent)", async () => {
    const pool = new RequirementCompilerPool();
    seedSpec(pool);
    // No contract seeded.
    const { app, events } = buildHarness({
      pool,
      actor,
      actorFactory: () => fakeActorReturning([], "none"),
    });
    const response = await app.request(
      `/orgs/${ORG}/projects/${PROJECT}/specs/${SPEC}/compile-integration-requirements`,
      { method: "POST" },
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe("design_contract_absent");
    expect(pool.insertedRequirements).toHaveLength(0);
    expect(events.appends).toHaveLength(0);
  });

  it("502 when the LLM produces a malformed requirement (fail-loud — no lexical fallback)", async () => {
    const pool = new RequirementCompilerPool();
    seedSpec(pool);
    seedContract(pool);
    const badActor: RequirementCompilerActor = {
      async compile(input) {
        throw new MalformedRequirementCompilerResultError(
          input.projectId,
          input.specId,
          "requirements[0] failed validation: capability [plane_capability_mismatch]",
        );
      },
    };
    const { app, events } = buildHarness({
      pool,
      actor,
      actorFactory: () => badActor,
    });
    const response = await app.request(
      `/orgs/${ORG}/projects/${PROJECT}/specs/${SPEC}/compile-integration-requirements`,
      { method: "POST" },
    );
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("malformed_requirement_compiler_result");
    expect(body.detail).toMatch(/plane_capability_mismatch/u);
    // No orphan rows, no events.
    expect(pool.insertedRequirements).toHaveLength(0);
    expect(events.appends).toHaveLength(0);
  });

  it("403 when the actor cannot access the org (RLS gate before any query)", async () => {
    const pool = new RequirementCompilerPool();
    seedSpec(pool);
    seedContract(pool);
    const offScopeActor: ActorContext = {
      userId: "user_evil",
      orgId: "org_other",
      projectId: null,
      scopes: [],
      source: "session",
    };
    const { app, events } = buildHarness({
      pool,
      actor: offScopeActor,
      actorFactory: () => fakeActorReturning([], "none"),
    });
    const response = await app.request(
      `/orgs/${ORG}/projects/${PROJECT}/specs/${SPEC}/compile-integration-requirements`,
      { method: "POST" },
    );
    expect(response.status).toBe(403);
    expect(pool.insertedRequirements).toHaveLength(0);
    expect(events.appends).toHaveLength(0);
  });

  it("passes the loaded spec + contract context to the actor (proof the route loads before compiling)", async () => {
    const pool = new RequirementCompilerPool();
    seedSpec(pool);
    seedContract(pool);
    let capturedInput:
      | {
          specTitle: string;
          specDescription: string;
          acceptanceCriteria: string[];
          designContractVersion: number;
          designContractId: string;
        }
      | undefined;
    const capturingActor: RequirementCompilerActor = {
      async compile(input) {
        capturedInput = {
          specTitle: input.specTitle,
          specDescription: input.specDescription,
          acceptanceCriteria: [...input.acceptanceCriteria],
          designContractVersion: input.designContractVersion,
          designContractId: input.designContractId,
        };
        return { requirements: [], rationale: "ok", digests: [] };
      },
    };
    const { app } = buildHarness({
      pool,
      actor,
      actorFactory: () => capturingActor,
    });
    await app.request(`/orgs/${ORG}/projects/${PROJECT}/specs/${SPEC}/compile-integration-requirements`, {
      method: "POST",
    });
    expect(capturedInput).toBeDefined();
    expect(capturedInput!.specTitle).toBe("Celebrate 100 clicks");
    expect(capturedInput!.acceptanceCriteria).toEqual([
      "Given a short link with 99 clicks, when the 100th click is recorded, then a Slack message is posted",
    ]);
    expect(capturedInput!.designContractVersion).toBe(1);
    expect(capturedInput!.designContractId).toBe("design_001");
  });
});
