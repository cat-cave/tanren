// cspell:ignore nobypassrls plpgsql
import { migrate, resetSystemPool, runWithOrgScope, setSystemPool } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgDagReadModel } from "../src/engine/dag/walkerPg.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { buildEntityGraphWithReceipt } from "../src/engine/forge/interview/deriveEntityGraph.js";
import { scaffoldSpecsFor } from "../src/engine/forge/interview/deriveScaffoldSpecs.js";
import {
  ProjectDerivationStore,
  projectDerivationFingerprint,
  type ProjectDerivationConflictError,
  withProjectDerivationLock,
} from "../src/engine/repositories/projects.js";
import type { DeriveInput } from "../src/engine/forge/interview/derive.js";
import { runDirectGreenfieldDerivation } from "../src/routes/projects/greenfieldCreateStateMachine.js";
import { FakeRepoCreateHttp } from "./conformance/fakes/fakeRepoCreateHttp.js";
import { preparedDeploy } from "./fixtures/forge/interviewDeriveStub.js";
import {
  activationTuple,
  corruptReceipt,
  DERIVATION_ACTOR as ACTOR,
  directSanitizedInput,
  GRAPH_CAPTURE,
  graphCounts,
  graphCapturedDesign,
  ownership as buildOwnership,
  repository,
  SEED,
  seedActivationPrerequisites,
} from "./fixtures/projectDerivationLifecycle.js";

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
const ownership = (projectId: string, repoUrl: string, fingerprint: string) =>
  buildOwnership(ORG_A, projectId, repoUrl, fingerprint);

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
  let bootstraps: Awaited<ReturnType<typeof seedActivationPrerequisites>> = new Map();

  function ownerPool(): Pool {
    if (owner === undefined) throw new Error("owner pool is not initialized");
    return owner;
  }
  function runtimePool(): Pool {
    if (runtime === undefined) throw new Error("runtime pool is not initialized");
    return runtime;
  }
  const bootstrap = (projectId: string) => bootstraps.get(projectId)!;

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
    bootstraps = await seedActivationPrerequisites(runtime, ORG_A, [
      { projectId: PROJECT_FAILED, repoUrl: "https://github.com/cat-cave/derivation-failed" },
      { projectId: PROJECT_CONCURRENT, repoUrl: "https://github.com/cat-cave/derivation-concurrent" },
      { projectId: PROJECT_GRAPH, repoUrl: "https://github.com/cat-cave/derivation-graph" },
      { projectId: PROJECT_ACTIVATION, repoUrl: "https://github.com/cat-cave/derivation-activation" },
    ]);
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

  it("rejects incomplete, foreign, and malformed receipts while work stays dormant and tenant-isolated", async () => {
    const pool = runtimePool();
    const repoUrl = "https://github.com/cat-cave/derivation-failed";
    const fingerprint = projectDerivationFingerprint({
      kind: "direct_greenfield",
      orgId: ORG_A,
      repoUrl,
      request: { capture: "failure-proof" },
    });
    let operation = await ProjectDerivationStore.begin(pool, {
      orgId: ORG_A,
      projectId: PROJECT_FAILED,
      idempotencyFingerprint: fingerprint,
      sanitizedInput: directSanitizedInput(),
      ownershipReceipt: ownership(PROJECT_FAILED, repoUrl, fingerprint),
    });

    const dormant = await new PgDagReadModel(pool).loadSnapshot(PROJECT_FAILED);
    expect(dormant).toEqual({ projectId: PROJECT_FAILED, nodes: [], projectLifecycle: "deriving" });
    await expect(ProjectDerivationStore.activate(pool, operation)).rejects.toMatchObject({
      reason: "incomplete_receipts",
    } satisfies Partial<ProjectDerivationConflictError>);

    operation = await ProjectDerivationStore.recordReceipt(pool, operation, "repository", repository(repoUrl), "shell");
    operation = await ProjectDerivationStore.recordReceipt(
      pool,
      operation,
      "deploy_intent",
      { effect: "deploy", idempotencyKey: `${fingerprint}:deploy` },
      "graph",
    );
    operation = await ProjectDerivationStore.recordReceipt(pool, operation, "deploy", preparedDeploy(), "graph");
    operation = await ProjectDerivationStore.recordReceipt(
      pool,
      operation,
      "bootstrap",
      bootstrap(PROJECT_FAILED),
      "activate",
    );

    await corruptReceipt(ownerPool(), PROJECT_FAILED, "{repository,binding,projectId}", "project_foreign");
    await expect(ProjectDerivationStore.activate(pool, operation)).rejects.toMatchObject({
      reason: "binding_mismatch",
    } satisfies Partial<ProjectDerivationConflictError>);
    operation = await ProjectDerivationStore.recordReceipt(pool, operation, "repository", repository(repoUrl), "shell");
    await corruptReceipt(ownerPool(), PROJECT_FAILED, "{repository,value,repoUrl}", "https://github.com/other/repo");
    await expect(ProjectDerivationStore.activate(pool, operation)).rejects.toMatchObject({
      reason: "binding_mismatch",
    } satisfies Partial<ProjectDerivationConflictError>);
    operation = await ProjectDerivationStore.recordReceipt(pool, operation, "repository", repository(repoUrl), "shell");
    await corruptReceipt(ownerPool(), PROJECT_FAILED, "{deploy,value,outcome,providerKind}", "deploy.flyio");
    await expect(ProjectDerivationStore.activate(pool, operation)).rejects.toMatchObject({
      reason: "binding_mismatch",
    } satisfies Partial<ProjectDerivationConflictError>);
    operation = await ProjectDerivationStore.recordReceipt(pool, operation, "deploy", preparedDeploy(), "graph");
    await ownerPool().query(
      "UPDATE project_derivations SET result_receipt = jsonb_set(result_receipt, '{bootstrap}', 'null'::jsonb) WHERE project_id = $1",
      [PROJECT_FAILED],
    );
    await expect(ProjectDerivationStore.activate(pool, operation)).rejects.toMatchObject({
      reason: "invalid_receipt",
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

  it("rejects the A/fingerprint -> moved A -> repo-bound B retry before provider effects", async () => {
    const pool = runtimePool();
    const repoUrl = "https://github.com/cat-cave/binding-target";
    const input = {
      name: "binding-target",
      owner: "cat-cave",
      greenfield: true,
      deploy: { providerKind: "deploy.vercel" },
    } as const;
    const fingerprint = projectDerivationFingerprint({
      kind: "direct_greenfield",
      orgId: ORG_A,
      repoUrl,
      request: input,
    });
    await runWithOrgScope(pool, ORG_A, async (client) => {
      await client.query(
        "INSERT INTO projects (project_id, name, repo_url, org_id, lifecycle) VALUES ($1, $2, $3, $4, 'deriving')",
        ["project_binding_a", input.name, repoUrl, ORG_A],
      );
    });
    await ProjectDerivationStore.begin(pool, {
      orgId: ORG_A,
      projectId: "project_binding_a",
      idempotencyFingerprint: fingerprint,
      sanitizedInput: { kind: "direct_greenfield", input },
      ownershipReceipt: ownership("project_binding_a", repoUrl, fingerprint),
    });
    await runWithOrgScope(pool, ORG_A, async (client) => {
      await client.query("UPDATE projects SET repo_url = $1 WHERE project_id = 'project_binding_a'", [
        "https://github.com/cat-cave/binding-moved",
      ]);
      await client.query(
        "INSERT INTO projects (project_id, name, repo_url, org_id, lifecycle) VALUES ('project_binding_b', $1, $2, $3, 'deriving')",
        [input.name, repoUrl, ORG_A],
      );
    });
    let downstreamEffects = 0;
    const githubHttp = new FakeRepoCreateHttp();
    const result = await runDirectGreenfieldDerivation(
      {
        pool,
        secrets: new InMemorySecretStore(),
        githubHttp,
        orgId: ORG_A,
        actor: ACTOR,
        input,
        async preflightDeploy() {
          downstreamEffects += 1;
        },
        async prepareDeploy() {
          downstreamEffects += 1;
          return preparedDeploy();
        },
        async bootstrapProject() {
          downstreamEffects += 1;
          return { errors: [] };
        },
      },
      repoUrl,
    );
    expect(result).toEqual({ kind: "conflict", reason: "repo_bound_without_derivation" });
    expect(downstreamEffects).toBe(0);
    expect(githubHttp.createdRepositories).toEqual([]);
    expect((await ProjectDerivationStore.findByFingerprint(pool, ORG_A, fingerprint))?.projectId).toBe(
      "project_binding_a",
    );
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
    const initial = await ProjectDerivationStore.begin(pool, {
      orgId: ORG_A,
      projectId: PROJECT_CONCURRENT,
      idempotencyFingerprint: fingerprint,
      sanitizedInput: directSanitizedInput(),
      ownershipReceipt: ownership(PROJECT_CONCURRENT, repoUrl, fingerprint),
    });
    await ProjectDerivationStore.recordReceipt(pool, initial, "repository", repository(repoUrl), "shell");
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
              { effect: "deploy", idempotencyKey: `${fingerprint}:deploy` },
              "graph",
            );
          }
          deployEffects += 1;
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 40);
          });
          current = await ProjectDerivationStore.recordReceipt(pool, current, "deploy", preparedDeploy(), "graph");
        }
        if (current.resultReceipt["bootstrap"] === undefined) {
          bootstrapEffects += 1;
          current = await ProjectDerivationStore.recordReceipt(
            pool,
            current,
            "bootstrap",
            bootstrap(PROJECT_CONCURRENT),
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
      sanitizedInput: directSanitizedInput(),
      ownershipReceipt: ownership(PROJECT_ACTIVATION, repoUrl, fingerprint),
    });
    operation = await ProjectDerivationStore.recordReceipt(pool, operation, "repository", repository(repoUrl), "shell");
    operation = await ProjectDerivationStore.recordReceipt(
      pool,
      operation,
      "deploy_intent",
      { effect: "deploy", idempotencyKey: `${fingerprint}:deploy` },
      "graph",
    );
    operation = await ProjectDerivationStore.recordReceipt(pool, operation, "deploy", preparedDeploy(), "graph");
    operation = await ProjectDerivationStore.recordReceipt(
      pool,
      operation,
      "bootstrap",
      bootstrap(PROJECT_ACTIVATION),
      "activate",
    );

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
    expect(await activationTuple(pool, ORG_A, PROJECT_ACTIVATION)).toEqual({
      lifecycle: "deriving",
      status: "in_progress",
    });

    await ownerPool().query("DROP TRIGGER fail_derivation_activation_receipt ON project_derivations");
    await ownerPool().query("DROP FUNCTION fail_derivation_activation_receipt() ");
    const completed = await ProjectDerivationStore.activate(pool, operation);
    expect(completed.status).toBe("succeeded");
    expect(await activationTuple(pool, ORG_A, PROJECT_ACTIVATION)).toEqual({
      lifecycle: "active",
      status: "succeeded",
    });
  });

  it("commits graph rows and the graph receipt as one retry boundary", async () => {
    const pool = runtimePool();
    const repoUrl = "https://github.com/cat-cave/derivation-graph";
    const baseInput: DeriveInput = { orgId: ORG_A, capture: GRAPH_CAPTURE, actor: ACTOR };
    const lifecycle = GRAPH_CAPTURE.lifecycle;
    if (lifecycle === null) throw new Error("graph lifecycle fixture missing");
    const scaffold = scaffoldSpecsFor(lifecycle, SEED);
    const fingerprint = projectDerivationFingerprint({
      kind: "interview",
      orgId: ORG_A,
      repoUrl,
      request: { capture: "graph-receipt-proof" },
    });
    const design = graphCapturedDesign(fingerprint);
    const operation = await ProjectDerivationStore.begin(pool, {
      orgId: ORG_A,
      projectId: PROJECT_GRAPH,
      idempotencyFingerprint: fingerprint,
      sanitizedInput: {
        kind: "interview",
        deploy: { providerKind: "deploy.vercel" },
        designMode: "captured",
        designInputDigest: design.inputDigest,
      },
      ownershipReceipt: ownership(PROJECT_GRAPH, repoUrl, fingerprint),
    });
    await ownerPool().query(`
      CREATE FUNCTION fail_graph_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.project_id = '${PROJECT_GRAPH}' AND NEW.result_receipt ? 'graph' THEN
          RAISE EXCEPTION 'injected graph receipt failure';
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER fail_graph_receipt BEFORE UPDATE ON project_derivations
        FOR EACH ROW EXECUTE FUNCTION fail_graph_receipt();
    `);
    await expect(
      buildEntityGraphWithReceipt(
        pool,
        baseInput,
        GRAPH_CAPTURE,
        "atomic-graph",
        SEED,
        undefined,
        PROJECT_GRAPH,
        ACTOR,
        scaffold,
        operation,
        design,
      ),
    ).rejects.toThrow(/graph receipt failure/iu);

    const empty = await graphCounts(ownerPool(), PROJECT_GRAPH);
    expect(empty).toEqual({ personas: 0, milestones: 0, specs: 0, behaviors: 0, designContracts: 0 });
    expect(
      (await ProjectDerivationStore.findForProject(pool, ORG_A, PROJECT_GRAPH))?.resultReceipt["graph"],
    ).toBeUndefined();

    await ownerPool().query("DROP TRIGGER fail_graph_receipt ON project_derivations");
    await ownerPool().query("DROP FUNCTION fail_graph_receipt()");
    const { graph, operation: completed } = await buildEntityGraphWithReceipt(
      pool,
      baseInput,
      GRAPH_CAPTURE,
      "atomic-graph",
      SEED,
      undefined,
      PROJECT_GRAPH,
      ACTOR,
      scaffold,
      operation,
      design,
    );
    const persisted = await graphCounts(ownerPool(), PROJECT_GRAPH);
    expect(persisted).toEqual({
      personas: graph.personaIds.length,
      milestones: graph.milestoneIds.length,
      specs: graph.specIds.length,
      behaviors: graph.behaviorIds.length,
      designContracts: 1,
    });
    expect(completed.resultReceipt["graph"]).toBeDefined();
    expect(persisted.personas).toBeGreaterThan(0);
    expect(persisted.specs).toBeGreaterThan(0);
  });
});
