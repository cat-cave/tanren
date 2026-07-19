// cspell:ignore dsgate incon
// ds-4 sub-node #3 — real-Postgres proof that `resolveDesignRenderGate` reads the run's
// design-render outcome under org scope (RLS) and classifies it fail-closed. The DB-less
// decision table is pinned in designRenderLandGate.test.ts; this proves the SQL join
// (runs → design_render_land_verdicts for the run's project) + the org-scoped read + the
// producer's persistence seam (`recordDesignRenderVerdict`). Gated on TANREN_RLS_DB_TEST.
import { migrate } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveDesignRenderGate } from "../src/engine/merge/designRenderLandGate.js";
import { recordDesignRenderVerdict } from "../src/engine/design/render/designRenderVerdictStore.js";
import type { DesignRenderVerification } from "../src/engine/design/render/designRenderVerdict.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG = "org_dsgate";
const PROJECT = "project_dsgate";
const SPEC_ID = "spec_dsgate";

function databaseName(): string {
  return `tanren_dsgate_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function connectionUrl(database: string, role?: { user: string; password: string }): string {
  const parsed = new URL(ADMIN_URL);
  parsed.pathname = `/${database}`;
  if (role !== undefined) {
    parsed.username = role.user;
    parsed.password = role.password;
  }
  return parsed.toString();
}

async function seedTenant(owner: Pool): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [ORG],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, $1, 'https://example.com/repo.git', 'main', 'runner:v0', $2, '{}'::jsonb)`,
    [PROJECT, ORG],
  );
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
     VALUES ($1, $2, $3, 'dsgate', 'design gate coverage', 'in_flight')`,
    [SPEC_ID, PROJECT, ORG],
  );
}

async function seedRun(owner: Pool, runId: string): Promise<void> {
  await owner.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
     VALUES ($1, $2, $3, $4, 'cli', 'feat', 'running')`,
    [runId, SPEC_ID, PROJECT, ORG],
  );
}

function verification(
  outcome: DesignRenderVerification["outcome"],
  overrides: Partial<DesignRenderVerification> = {},
): DesignRenderVerification {
  return {
    outcome,
    accessibilityStandard: outcome === "not_applicable" ? "none" : "wcag-2.2-aa",
    checkpoints:
      outcome === "passed"
        ? [{ checkpointId: "button:light:desktop:en-US", verdict: "passed", failingRuleIds: [] }]
        : outcome === "failed_visual"
          ? [{ checkpointId: "button:dark:mobile:en-US", verdict: "failed", failingRuleIds: ["button-name"] }]
          : [],
    passedCount: outcome === "passed" ? 1 : 0,
    failedCount: outcome === "failed_visual" ? 1 : 0,
    inconclusiveCount: outcome === "inconclusive_infrastructure" ? 1 : 0,
    excludedCount: 0,
    failingScenarioKey: outcome === "failed_visual" ? "button:dark:mobile:en-US" : null,
    failingRuleIds: outcome === "failed_visual" ? ["button-name"] : [],
    ...overrides,
  };
}

async function persist(app: Pool, outcome: DesignRenderVerification["outcome"]): Promise<void> {
  await recordDesignRenderVerdict(app, {
    orgId: ORG,
    projectId: PROJECT,
    designSystemId: "design_web_system_x",
    releaseId: "design_web_release_x",
    designContractVersion: "1",
    verification: verification(outcome),
  });
}

describeDb("resolveDesignRenderGate — org-scoped land-time read", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: connectionUrl(database) });
    await migrate(owner);
    app = new Pool({ connectionString: connectionUrl(database, { user: APP_ROLE, password: APP_PASSWORD }) });
    await seedTenant(owner);
  }, 60_000);

  afterAll(async () => {
    await app?.end();
    await owner?.end();
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }, 30_000);

  it("no design-render verdict + no design system for the run → not_applicable (never blocks a non-design run)", async () => {
    await seedRun(owner, "run_none");
    expect(await resolveDesignRenderGate(app, ORG, "run_none")).toEqual({ kind: "not_applicable" });
  });

  it("a passed verdict → passed", async () => {
    await seedRun(owner, "run_pass");
    await persist(app, "passed");
    expect(await resolveDesignRenderGate(app, ORG, "run_pass")).toEqual({ kind: "passed", passedCheckpointCount: 1 });
  });

  it("a failed_visual verdict → failed (fail closed), carrying the failing scenario + rule ids", async () => {
    await seedRun(owner, "run_fail");
    await persist(app, "failed_visual");
    const gate = await resolveDesignRenderGate(app, ORG, "run_fail");
    expect(gate).toMatchObject({
      kind: "failed",
      failingScenarioKey: "button:dark:mobile:en-US",
      failingRuleIds: ["button-name"],
    });
  });

  it("an inconclusive_infrastructure verdict → inconclusive (fail closed; inconclusive ≠ passed)", async () => {
    await seedRun(owner, "run_incon");
    await persist(app, "inconclusive_infrastructure");
    expect((await resolveDesignRenderGate(app, ORG, "run_incon")).kind).toBe("inconclusive");
  });

  it("a not_applicable verdict (posture 'none') → not_applicable (advisory design never blocks)", async () => {
    await seedRun(owner, "run_na");
    await persist(app, "not_applicable");
    expect(await resolveDesignRenderGate(app, ORG, "run_na")).toEqual({ kind: "not_applicable" });
  });

  it("the LATEST verdict wins (a later passed supersedes an earlier failed)", async () => {
    await seedRun(owner, "run_latest");
    await persist(app, "failed_visual");
    await persist(app, "passed");
    expect((await resolveDesignRenderGate(app, ORG, "run_latest")).kind).toBe("passed");
  });

  it("the read is org-scoped — a foreign org sees no verdict (not_applicable)", async () => {
    await seedRun(owner, "run_scope");
    await persist(app, "failed_visual");
    // Under the OWNING org the failure gates; under a different org RLS hides the rows so the
    // reader resolves no run/verdict at all → not_applicable (RLS denies by default).
    expect((await resolveDesignRenderGate(app, ORG, "run_scope")).kind).toBe("failed");
    expect(await resolveDesignRenderGate(app, "org_other", "run_scope")).toEqual({ kind: "not_applicable" });
  });
});
