// cspell:ignore nobypassrls plpgsql
/**
 * Real-Postgres proof for the deriving -> active boundary. Opt in with
 * TANREN_RLS_DB_TEST=1. This deliberately uses the NOBYPASSRLS runtime role for
 * every tenant read/write and a separate system pool only for walker discovery.
 */
import { migrate, resetSystemPool, runWithOrgScope, setSystemPool } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgDagReadModel } from "../src/engine/dag/walkerPg.js";
import { buildEntityGraph } from "../src/engine/forge/interview/deriveEntityGraph.js";
import { scaffoldSpecsFor } from "../src/engine/forge/interview/deriveScaffoldSpecs.js";
import { InterviewCapture } from "../src/engine/forge/interview/types.js";
import {
  ProjectDerivationStore,
  projectDerivationFingerprint,
  type ProjectDerivationConflictError,
  withProjectDerivationLock,
} from "../src/engine/repositories/projects.js";
import type { ActorContext } from "../src/auth/schemas.js";
import type { DeriveInput } from "../src/engine/forge/interview/derive.js";
import type { SeededTemplate } from "../src/engine/templates/index.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_A = "org_derivation_a";
const ORG_B = "org_derivation_b";
const PROJECT_FAILED = "project_derivation_failed";
const PROJECT_CONCURRENT = "project_derivation_concurrent";
const PROJECT_GRAPH = "project_derivation_graph";
const PROJECT_ACTIVATION = "project_derivation_activation";
const ACTOR: ActorContext = {
  userId: "derivation-test",
  orgId: ORG_A,
  projectId: null,
  scopes: ["platform:admin"],
  source: "local_dev",
};
const SEED: SeededTemplate = {
  templateRef: "tanren://composed/proof@1234567890ab",
  validatedAt: "2026-07-16T00:00:00.000Z",
};
/* eslint-disable unicorn/no-thenable -- Given/When/Then is the persisted behavior vocabulary. */
const GRAPH_CAPTURE = InterviewCapture.parse({
  identity: { slug: "atomic-graph", pitch: "Atomic graph proof", repoHint: "" },
  personas: [{ name: "Operator", description: "Runs the product", surface: "console" }],
  behaviors: [
    {
      persona: "Operator",
      title: "inspect status",
      given: "a running product",
      when: "the operator opens status",
      then: "the current status is visible",
    },
  ],
  interfaces: [{ name: "console", note: "operator surface" }],
  designContract: {
    domain: "operations-console",
    identity: "a clear operations console",
    intent: "make status legible",
    principles: [],
    constraints: [],
    personas: ["Operator"],
    behaviors: ["operator::inspect status"],
    dimensions: [],
  },
  architecture: [],
  lifecycle: {
    stack: "proof/toolchain",
    bootstrap: "just bootstrap",
    tier1: "just tier-1",
    tier2: "just tier-2",
    tier3: "just tier-3",
    build: "just build",
    deploy: "just deploy",
    toolchain: [],
  },
  lifecycleConfirmed: true,
  rulesets: [],
});
/* eslint-enable unicorn/no-thenable */

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function withRole(url: string, database: string): string {
  const parsed = new URL(withDatabase(url, database));
  parsed.username = APP_ROLE;
  parsed.password = APP_PASSWORD;
  return parsed.toString();
}

describeDb("project derivation lifecycle — real PostgreSQL, RLS, and concurrent retry", () => {
  const database = `tanren_project_derivation_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let owner: Pool | undefined;
  let runtime: Pool | undefined;

  function ownerPool(): Pool {
    if (owner === undefined) throw new Error("owner pool is not initialized");
    return owner;
  }

  function runtimePool(): Pool {
    if (runtime === undefined) throw new Error("runtime pool is not initialized");
    return runtime;
  }

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(owner);
    runtime = new Pool({ connectionString: withRole(ADMIN_URL, database) });
    setSystemPool(owner);

    for (const orgId of [ORG_A, ORG_B]) {
      await owner.query(
        `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
         VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
        [orgId],
      );
    }
    await owner.query(
      `INSERT INTO projects (project_id, name, repo_url, org_id, lifecycle) VALUES
         ($1, $1, 'https://github.com/cat-cave/derivation-failed', $3, 'deriving'),
         ($2, $2, 'https://github.com/cat-cave/derivation-concurrent', $3, 'deriving'),
         ($4, $4, 'https://github.com/cat-cave/derivation-graph', $3, 'deriving'),
         ($5, $5, 'https://github.com/cat-cave/derivation-activation', $3, 'deriving')`,
      [PROJECT_FAILED, PROJECT_CONCURRENT, ORG_A, PROJECT_GRAPH, PROJECT_ACTIVATION],
    );
    await owner.query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description)
       VALUES ('spec_derivation_ready', $1, $2, 'ready root', 'must wait for activation')`,
      [PROJECT_CONCURRENT, ORG_A],
    );
  }, 120_000);

  afterAll(async () => {
    resetSystemPool();
    await runtime?.end();
    await owner?.end();
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }, 30_000);

  it("fails closed on missing receipts and keeps failed work dormant and tenant-isolated", async () => {
    const pool = runtimePool();
    const repoUrl = "https://github.com/cat-cave/derivation-failed";
    const fingerprint = projectDerivationFingerprint({
      kind: "interview",
      orgId: ORG_A,
      repoUrl,
      request: { capture: "failure-proof" },
    });
    let operation = await ProjectDerivationStore.begin(pool, {
      orgId: ORG_A,
      projectId: PROJECT_FAILED,
      idempotencyFingerprint: fingerprint,
      sanitizedInput: { kind: "interview" },
      ownershipReceipt: { repository: { repoUrl } },
    });

    const dormant = await new PgDagReadModel(pool).loadSnapshot(PROJECT_FAILED);
    expect(dormant).toEqual({ projectId: PROJECT_FAILED, nodes: [], projectLifecycle: "deriving" });
    await expect(ProjectDerivationStore.activate(pool, operation)).rejects.toMatchObject({
      reason: "incomplete_receipts",
    } satisfies Partial<ProjectDerivationConflictError>);

    operation = await ProjectDerivationStore.recordTemplate(pool, operation, { templateRef: "tanren://proof" });
    operation = await ProjectDerivationStore.recordReceipt(
      pool,
      operation,
      "template_intent",
      { idempotencyKey: `${fingerprint}:template` },
      "template",
    );
    operation = await ProjectDerivationStore.recordReceipt(
      pool,
      operation,
      "deploy_intent",
      { idempotencyKey: `${fingerprint}:deploy` },
      "graph",
    );
    operation = await ProjectDerivationStore.recordReceipt(pool, operation, "deploy", { appId: "app_failed" }, "graph");
    operation = await ProjectDerivationStore.recordReceipt(pool, operation, "bootstrap", { errors: [] }, "activate");
    await expect(ProjectDerivationStore.activate(pool, operation)).rejects.toMatchObject({
      reason: "incomplete_receipts",
    } satisfies Partial<ProjectDerivationConflictError>);
    await ProjectDerivationStore.recordFailure(pool, operation, new Error("permanent graph failure"));

    const ownRow = await ProjectDerivationStore.findForProject(pool, ORG_A, PROJECT_FAILED);
    expect(ownRow).toMatchObject({ status: "in_progress", sanitizedError: { message: "permanent graph failure" } });
    expect(await ProjectDerivationStore.findForProject(pool, ORG_B, PROJECT_FAILED)).toBeUndefined();
    const bare = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM project_derivations");
    expect(bare.rows[0]?.count).toBe("0");
    const wrongScope = await runWithOrgScope(pool, ORG_B, (client) =>
      client.query<{ count: string }>("SELECT count(*)::text AS count FROM project_derivations WHERE project_id = $1", [
        PROJECT_FAILED,
      ]),
    );
    expect(wrongScope.rows[0]?.count).toBe("0");
    expect((await new PgDagReadModel(pool).loadSnapshot(PROJECT_FAILED)).projectLifecycle).toBe("deriving");
  });

  it("serializes duplicate retries, records each external effect once, and activates exactly once", async () => {
    const pool = runtimePool();
    const repoUrl = "https://github.com/cat-cave/derivation-concurrent";
    const fingerprint = projectDerivationFingerprint({
      kind: "direct_greenfield",
      orgId: ORG_A,
      repoUrl,
      request: { name: "derivation-concurrent", owner: "cat-cave" },
    });
    await ProjectDerivationStore.begin(pool, {
      orgId: ORG_A,
      projectId: PROJECT_CONCURRENT,
      idempotencyFingerprint: fingerprint,
      sanitizedInput: { kind: "direct_greenfield" },
      ownershipReceipt: { repository: { repoUrl } },
    });
    let deployEffects = 0;
    let bootstrapEffects = 0;

    const retry = () =>
      withProjectDerivationLock(pool, ORG_A, repoUrl, async () => {
        let current = await ProjectDerivationStore.findForProject(pool, ORG_A, PROJECT_CONCURRENT);
        if (current === undefined) throw new Error("derivation fixture missing");
        if (current.resultReceipt["deploy"] === undefined) {
          if (current.resultReceipt["deploy_intent"] === undefined) {
            current = await ProjectDerivationStore.recordReceipt(
              pool,
              current,
              "deploy_intent",
              { idempotencyKey: `${fingerprint}:deploy` },
              "graph",
            );
          }
          deployEffects += 1;
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 40);
          });
          current = await ProjectDerivationStore.recordReceipt(pool, current, "deploy", { appId: "app_once" }, "graph");
        }
        if (current.resultReceipt["bootstrap"] === undefined) {
          bootstrapEffects += 1;
          current = await ProjectDerivationStore.recordReceipt(
            pool,
            current,
            "bootstrap",
            { errors: [], sourceId: "source_once" },
            "activate",
          );
        }
        return ProjectDerivationStore.activate(pool, current);
      });

    const [first, second] = await Promise.all([retry(), retry()]);
    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("succeeded");
    expect(first.id).toBe(second.id);
    expect(deployEffects).toBe(1);
    expect(bootstrapEffects).toBe(1);
    const persisted = await ProjectDerivationStore.findForProject(pool, ORG_A, PROJECT_CONCURRENT);
    expect(persisted).toMatchObject({ status: "succeeded", phase: "activate" });

    const project = await runWithOrgScope(pool, ORG_A, (client) =>
      client.query<{ lifecycle: string }>("SELECT lifecycle FROM projects WHERE org_id = $1 AND project_id = $2", [
        ORG_A,
        PROJECT_CONCURRENT,
      ]),
    );
    expect(project.rows[0]?.lifecycle).toBe("active");
    const runnable = await new PgDagReadModel(pool).loadSnapshot(PROJECT_CONCURRENT);
    expect(runnable.projectLifecycle).toBe("active");
    expect(runnable.nodes.map((node) => node.specId)).toEqual(["spec_derivation_ready"]);
  });

  it("atomically rolls back both activation writes when the receipt transition is interrupted", async () => {
    const pool = runtimePool();
    const repoUrl = "https://github.com/cat-cave/derivation-activation";
    const fingerprint = projectDerivationFingerprint({
      kind: "direct_greenfield",
      orgId: ORG_A,
      repoUrl,
      request: { name: "derivation-activation", owner: "cat-cave" },
    });
    let operation = await ProjectDerivationStore.begin(pool, {
      orgId: ORG_A,
      projectId: PROJECT_ACTIVATION,
      idempotencyFingerprint: fingerprint,
      sanitizedInput: { kind: "direct_greenfield" },
      ownershipReceipt: { repository: { repoUrl } },
    });
    operation = await ProjectDerivationStore.recordReceipt(
      pool,
      operation,
      "deploy_intent",
      { idempotencyKey: `${fingerprint}:deploy` },
      "graph",
    );
    operation = await ProjectDerivationStore.recordReceipt(pool, operation, "deploy", { appId: "app_once" }, "graph");
    operation = await ProjectDerivationStore.recordReceipt(pool, operation, "bootstrap", { errors: [] }, "activate");

    await ownerPool().query(`
      CREATE FUNCTION fail_derivation_activation_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.project_id = '${PROJECT_ACTIVATION}' AND NEW.status = 'succeeded' THEN
          RAISE EXCEPTION 'injected activation receipt failure';
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER fail_derivation_activation_receipt
        BEFORE UPDATE ON project_derivations
        FOR EACH ROW EXECUTE FUNCTION fail_derivation_activation_receipt();
    `);
    await expect(ProjectDerivationStore.activate(pool, operation)).rejects.toThrow(/activation receipt failure/iu);
    expect(await activationTuple(pool)).toEqual({ lifecycle: "deriving", status: "in_progress" });

    await ownerPool().query("DROP TRIGGER fail_derivation_activation_receipt ON project_derivations");
    await ownerPool().query("DROP FUNCTION fail_derivation_activation_receipt() ");
    const completed = await ProjectDerivationStore.activate(pool, operation);
    expect(completed.status).toBe("succeeded");
    expect(await activationTuple(pool)).toEqual({ lifecycle: "active", status: "succeeded" });
  });

  it("rolls an interrupted entity graph back atomically before a clean retry", async () => {
    const pool = runtimePool();
    const baseInput: DeriveInput = { orgId: ORG_A, capture: GRAPH_CAPTURE, actor: ACTOR };
    const lifecycle = GRAPH_CAPTURE.lifecycle;
    if (lifecycle === null) throw new Error("graph lifecycle fixture missing");
    const scaffold = scaffoldSpecsFor(lifecycle, SEED);
    await expect(
      buildEntityGraph(
        pool,
        {
          ...baseInput,
          designAgent: {
            async elaborate() {
              throw new Error("injected final graph phase failure");
            },
          },
        },
        GRAPH_CAPTURE,
        "atomic-graph",
        SEED,
        undefined,
        PROJECT_GRAPH,
        ACTOR,
        scaffold,
      ),
    ).rejects.toThrow(/final graph phase failure/iu);

    const empty = await graphCounts(ownerPool(), PROJECT_GRAPH);
    expect(empty).toEqual({ personas: 0, milestones: 0, specs: 0, behaviors: 0, designContracts: 0 });

    const result = await buildEntityGraph(
      pool,
      baseInput,
      GRAPH_CAPTURE,
      "atomic-graph",
      SEED,
      undefined,
      PROJECT_GRAPH,
      ACTOR,
      scaffold,
    );
    const persisted = await graphCounts(ownerPool(), PROJECT_GRAPH);
    expect(persisted).toEqual({
      personas: result.personaIds.length,
      milestones: result.milestoneIds.length,
      specs: result.specIds.length,
      behaviors: result.behaviorIds.length,
      designContracts: 1,
    });
    expect(persisted.personas).toBeGreaterThan(0);
    expect(persisted.specs).toBeGreaterThan(0);
  });
});

async function activationTuple(pool: Pool): Promise<{ lifecycle: string; status: string }> {
  return runWithOrgScope(pool, ORG_A, async (client) => {
    const result = await client.query<{ lifecycle: string; status: string }>(
      `SELECT p.lifecycle, d.status
         FROM projects p
         JOIN project_derivations d ON d.project_id = p.project_id AND d.org_id = p.org_id
        WHERE p.org_id = $1 AND p.project_id = $2`,
      [ORG_A, PROJECT_ACTIVATION],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("activation tuple missing");
    return row;
  });
}

async function graphCounts(pool: Pool, projectId: string): Promise<Record<string, number>> {
  const result = await pool.query<{
    personas: number;
    milestones: number;
    specs: number;
    behaviors: number;
    design_contracts: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM personas WHERE project_id = $1) AS personas,
       (SELECT count(*)::int FROM milestones WHERE project_id = $1) AS milestones,
       (SELECT count(*)::int FROM specs WHERE project_id = $1) AS specs,
       (SELECT count(*)::int FROM behaviors b JOIN personas p ON p.id = b.persona_id WHERE p.project_id = $1)
         AS behaviors,
       (SELECT count(*)::int FROM design_contracts WHERE project_id = $1) AS design_contracts`,
    [projectId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("graph count query returned no row");
  return {
    personas: row.personas,
    milestones: row.milestones,
    specs: row.specs,
    behaviors: row.behaviors,
    designContracts: row.design_contracts,
  };
}
