// cspell:ignore nobypassrls
import { migrate, resetSystemPool, setSystemPool } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEntityGraphWithReceipt } from "../src/engine/forge/interview/deriveEntityGraph.js";
import { scaffoldSpecsFor } from "../src/engine/forge/interview/deriveScaffoldSpecs.js";
import type { DeriveInput } from "../src/engine/forge/interview/derive.js";
import { ProjectDerivationStore, projectDerivationFingerprint } from "../src/engine/repositories/projects.js";
import { preparedDeploy } from "./fixtures/forge/interviewDeriveStub.js";
import {
  DERIVATION_ACTOR,
  directSanitizedInput,
  GRAPH_CAPTURE,
  graphDesignPlan,
  graphProviderDesign,
  ownership,
  repository,
  SEED,
  seedActivationPrerequisites,
  setReceiptValue,
} from "./fixtures/projectDerivationLifecycle.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG = "org_derivation_evidence";
const DIRECT_PROJECT = "project_derivation_evidence_direct";
const GRAPH_PROJECT = "project_derivation_evidence_graph";
const DIRECT_REPO = "https://github.com/cat-cave/derivation-evidence-direct";
const GRAPH_REPO = "https://github.com/cat-cave/derivation-evidence-graph";

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function appUrl(url: string, database: string): string {
  const parsed = new URL(withDatabase(url, database));
  parsed.username = "tanren_app";
  parsed.password = APP_PASSWORD;
  return parsed.toString();
}

describeDb("project derivation activation evidence — real PostgreSQL", () => {
  const database = `tanren_derivation_evidence_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let owner: Pool | undefined;
  let runtime: Pool | undefined;
  let bootstraps: Awaited<ReturnType<typeof seedActivationPrerequisites>> = new Map();

  const ownerPool = () => {
    if (owner === undefined) throw new Error("owner pool unavailable");
    return owner;
  };
  const runtimePool = () => {
    if (runtime === undefined) throw new Error("runtime pool unavailable");
    return runtime;
  };
  const bootstrap = (projectId: string) => bootstraps.get(projectId)!;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(owner);
    runtime = new Pool({ connectionString: appUrl(ADMIN_URL, database) });
    setSystemPool(owner);
    await owner.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
      [ORG],
    );
    await owner.query(
      `INSERT INTO projects (project_id, name, repo_url, org_id, lifecycle) VALUES
         ($1, 'derivation-evidence-direct', $2, $5, 'deriving'),
         ($3, 'atomic-graph', $4, $5, 'deriving')`,
      [DIRECT_PROJECT, DIRECT_REPO, GRAPH_PROJECT, GRAPH_REPO, ORG],
    );
    bootstraps = await seedActivationPrerequisites(runtime, ORG, [
      { projectId: DIRECT_PROJECT, repoUrl: DIRECT_REPO },
      { projectId: GRAPH_PROJECT, repoUrl: GRAPH_REPO },
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

  it("rejects partial bootstrap, branch drift, foreign surfaces, and stale or foreign authority", async () => {
    const fingerprint = projectDerivationFingerprint({
      kind: "direct_greenfield",
      orgId: ORG,
      repoUrl: DIRECT_REPO,
      request: { proof: "complete-activation-evidence" },
    });
    let operation = await ProjectDerivationStore.begin(runtimePool(), {
      orgId: ORG,
      projectId: DIRECT_PROJECT,
      idempotencyFingerprint: fingerprint,
      sanitizedInput: directSanitizedInput(),
      ownershipReceipt: ownership(ORG, DIRECT_PROJECT, DIRECT_REPO, fingerprint),
    });
    operation = await ProjectDerivationStore.recordReceipt(
      runtimePool(),
      operation,
      "repository",
      repository(DIRECT_REPO),
      "shell",
    );
    operation = await ProjectDerivationStore.recordReceipt(
      runtimePool(),
      operation,
      "deploy_intent",
      { effect: "deploy", idempotencyKey: `${fingerprint}:deploy` },
      "graph",
    );
    operation = await ProjectDerivationStore.recordReceipt(
      runtimePool(),
      operation,
      "deploy",
      preparedDeploy(),
      "graph",
    );
    operation = await ProjectDerivationStore.recordReceipt(
      runtimePool(),
      operation,
      "bootstrap",
      bootstrap(DIRECT_PROJECT),
      "activate",
    );

    await setReceiptValue(ownerPool(), DIRECT_PROJECT, "{bootstrap,value}", { errors: [] });
    await expect(ProjectDerivationStore.activate(runtimePool(), operation)).rejects.toMatchObject({
      reason: "invalid_receipt",
    });
    operation = await ProjectDerivationStore.recordReceipt(
      runtimePool(),
      operation,
      "bootstrap",
      bootstrap(DIRECT_PROJECT),
      "activate",
    );

    await ownerPool().query("UPDATE projects SET default_branch = 'develop' WHERE project_id = $1", [DIRECT_PROJECT]);
    await expect(ProjectDerivationStore.activate(runtimePool(), operation)).rejects.toMatchObject({
      reason: "binding_mismatch",
    });
    await ownerPool().query("UPDATE projects SET default_branch = 'main' WHERE project_id = $1", [DIRECT_PROJECT]);

    await setReceiptValue(ownerPool(), DIRECT_PROJECT, "{bootstrap,value,inboxSource,id}", "source_foreign");
    await expect(ProjectDerivationStore.activate(runtimePool(), operation)).rejects.toMatchObject({
      reason: "binding_mismatch",
    });
    operation = await ProjectDerivationStore.recordReceipt(
      runtimePool(),
      operation,
      "bootstrap",
      bootstrap(DIRECT_PROJECT),
      "activate",
    );

    const authorityCorruptions: Array<[string, unknown]> = [
      ["connectionId", "connection_foreign"],
      ["grantId", "grant_foreign"],
      ["providerPrincipalId", "account_foreign"],
      ["authGeneration", 2],
      ["grantGeneration", 2],
    ];
    for (const [field, value] of authorityCorruptions) {
      await setReceiptValue(ownerPool(), DIRECT_PROJECT, `{deploy,value,outcome,authority,${field}}`, value);
      await expect(ProjectDerivationStore.activate(runtimePool(), operation)).rejects.toMatchObject({
        reason: "binding_mismatch",
      });
      operation = await ProjectDerivationStore.recordReceipt(
        runtimePool(),
        operation,
        "deploy",
        preparedDeploy(),
        "graph",
      );
    }

    await setReceiptValue(
      ownerPool(),
      DIRECT_PROJECT,
      "{deploy,value,outcome,surfaces,deployRef}",
      "deploy.flyio:app_1",
    );
    await expect(ProjectDerivationStore.activate(runtimePool(), operation)).rejects.toMatchObject({
      reason: "binding_mismatch",
    });
    operation = await ProjectDerivationStore.recordReceipt(
      runtimePool(),
      operation,
      "deploy",
      preparedDeploy(),
      "graph",
    );

    await ownerPool().query(
      "UPDATE org_integration_connections SET health = 'degraded' WHERE org_id = $1 AND id = 'connection_1'",
      [ORG],
    );
    await expect(ProjectDerivationStore.activate(runtimePool(), operation)).rejects.toMatchObject({
      reason: "binding_mismatch",
    });
    await ownerPool().query(
      "UPDATE org_integration_connections SET health = 'healthy' WHERE org_id = $1 AND id = 'connection_1'",
      [ORG],
    );

    await ownerPool().query(
      "UPDATE audit_jobs SET kind = 'a11y' WHERE org_id = $1 AND project_id = $2 AND kind = 'deps'",
      [ORG, DIRECT_PROJECT],
    );
    await expect(ProjectDerivationStore.activate(runtimePool(), operation)).rejects.toMatchObject({
      reason: "binding_mismatch",
    });
    await ownerPool().query(
      "UPDATE audit_jobs SET kind = 'deps' WHERE org_id = $1 AND project_id = $2 AND kind = 'a11y'",
      [ORG, DIRECT_PROJECT],
    );
    await ownerPool().query(
      "UPDATE audit_jobs SET enabled = 'false' WHERE org_id = $1 AND project_id = $2 AND kind = 'security'",
      [ORG, DIRECT_PROJECT],
    );
    await expect(ProjectDerivationStore.activate(runtimePool(), operation)).rejects.toMatchObject({
      reason: "binding_mismatch",
    });
    await ownerPool().query(
      "UPDATE audit_jobs SET enabled = 'true' WHERE org_id = $1 AND project_id = $2 AND kind = 'security'",
      [ORG, DIRECT_PROJECT],
    );

    const targetId = bootstrap(DIRECT_PROJECT).notificationRoute!.targetId;
    await ownerPool().query(
      "UPDATE notification_routes SET event_name = 'allocator.allocated' WHERE target_id = $1 AND event_name = 'deploy.verified'",
      [targetId],
    );
    await expect(ProjectDerivationStore.activate(runtimePool(), operation)).rejects.toMatchObject({
      reason: "binding_mismatch",
    });
    await ownerPool().query(
      "UPDATE notification_routes SET event_name = 'deploy.verified' WHERE target_id = $1 AND event_name = 'allocator.allocated'",
      [targetId],
    );
    await ownerPool().query(
      "UPDATE notification_routes SET enabled = 0 WHERE target_id = $1 AND event_name = 'deploy.verified'",
      [targetId],
    );
    await expect(ProjectDerivationStore.activate(runtimePool(), operation)).rejects.toMatchObject({
      reason: "binding_mismatch",
    });
    await ownerPool().query(
      "UPDATE notification_routes SET enabled = 1, min_severity = 'fail' WHERE target_id = $1 AND event_name = 'deploy.verified'",
      [targetId],
    );
    await expect(ProjectDerivationStore.activate(runtimePool(), operation)).rejects.toMatchObject({
      reason: "binding_mismatch",
    });
    await ownerPool().query(
      "UPDATE notification_routes SET min_severity = 'warn' WHERE target_id = $1 AND event_name = 'deploy.verified'",
      [targetId],
    );
    await ownerPool().query(
      `INSERT INTO audit_jobs (id, org_id, project_id, kind, name, cadence, target_window, enabled)
       VALUES ('audit_extra', $1, $2, 'a11y', 'extra a11y audit', 'monthly', 'intentional extra', 'true')`,
      [ORG, DIRECT_PROJECT],
    );
    await ownerPool().query(
      `INSERT INTO notification_routes (id, target_id, event_name, enabled, min_severity)
       VALUES ('route_extra', $1, 'allocator.allocated', 1, 'warn')`,
      [targetId],
    );
    expect((await ProjectDerivationStore.activate(runtimePool(), operation)).status).toBe("succeeded");
  });

  it("rejects missing or foreign graph identities, then activates the exact persisted lineage", async () => {
    const fingerprint = projectDerivationFingerprint({
      kind: "interview",
      orgId: ORG,
      repoUrl: GRAPH_REPO,
      request: { proof: "complete-graph-evidence" },
    });
    const designPlan = graphDesignPlan(fingerprint);
    let operation = await ProjectDerivationStore.begin(runtimePool(), {
      orgId: ORG,
      projectId: GRAPH_PROJECT,
      idempotencyFingerprint: fingerprint,
      sanitizedInput: {
        kind: "interview",
        deploy: { providerKind: "deploy.vercel" },
        designMode: "provider",
        designInputDigest: designPlan.inputDigest,
      },
      ownershipReceipt: ownership(ORG, GRAPH_PROJECT, GRAPH_REPO, fingerprint),
    });
    operation = await ProjectDerivationStore.recordReceipt(
      runtimePool(),
      operation,
      "repository",
      repository(GRAPH_REPO),
      "shell",
    );
    operation = await ProjectDerivationStore.recordReceipt(
      runtimePool(),
      operation,
      "template_intent",
      { effect: "template", idempotencyKey: `${fingerprint}:template` },
      "template",
    );
    operation = await ProjectDerivationStore.recordTemplate(runtimePool(), operation, SEED);
    operation = await ProjectDerivationStore.recordReceipt(
      runtimePool(),
      operation,
      "deploy_intent",
      { effect: "deploy", idempotencyKey: `${fingerprint}:deploy` },
      "graph",
    );
    operation = await ProjectDerivationStore.recordReceipt(
      runtimePool(),
      operation,
      "deploy",
      preparedDeploy(),
      "graph",
    );
    operation = await ProjectDerivationStore.recordReceipt(
      runtimePool(),
      operation,
      "design_intent",
      { effect: "design", idempotencyKey: `${fingerprint}:design`, inputDigest: designPlan.inputDigest },
      "graph",
    );
    const persona = designPlan.agentInput.personas[0];
    const behavior = designPlan.agentInput.behaviors[0];
    if (persona === undefined || behavior === undefined) throw new Error("design graph fixture is incomplete");
    const designAnswer = {
      domain: "operations-console",
      identity: "a clear operations console",
      intent: "make status legible",
      principles: [],
      constraints: [],
      dimensions: [{ key: "status", label: "Status", intent: "Legible state", guidance: "", personaIds: [persona.id] }],
      coverage: [{ behaviorId: behavior.id, personaId: persona.id, dimensionKey: "status", surface: "status console" }],
    };
    const design = graphProviderDesign(fingerprint, designAnswer);
    operation = await ProjectDerivationStore.recordReceipt(runtimePool(), operation, "design", design, "graph");
    await expect(
      ProjectDerivationStore.recordReceipt(runtimePool(), operation, "design", design, "graph"),
    ).rejects.toMatchObject({ reason: "invalid_lifecycle" });
    const lifecycle = GRAPH_CAPTURE.lifecycle;
    if (lifecycle === null) throw new Error("graph lifecycle fixture missing");
    const graphWrite = await buildEntityGraphWithReceipt(
      runtimePool(),
      { orgId: ORG, capture: GRAPH_CAPTURE, actor: DERIVATION_ACTOR } satisfies DeriveInput,
      GRAPH_CAPTURE,
      "atomic-graph",
      SEED,
      repository(GRAPH_REPO),
      GRAPH_PROJECT,
      DERIVATION_ACTOR,
      scaffoldSpecsFor(lifecycle, SEED),
      operation,
      design,
    );
    operation = graphWrite.operation;
    operation = await ProjectDerivationStore.recordReceipt(
      runtimePool(),
      operation,
      "bootstrap",
      bootstrap(GRAPH_PROJECT),
      "activate",
    );

    await ownerPool().query(
      "UPDATE project_derivations SET result_receipt = result_receipt #- '{graph,value,designContract}' WHERE project_id = $1",
      [GRAPH_PROJECT],
    );
    await expect(ProjectDerivationStore.activate(runtimePool(), operation)).rejects.toMatchObject({
      reason: "invalid_receipt",
    });
    operation = await ProjectDerivationStore.recordReceipt(
      runtimePool(),
      operation,
      "graph",
      graphWrite.graph,
      "graph",
    );
    await setReceiptValue(ownerPool(), GRAPH_PROJECT, "{graph,value,personaIds}", ["persona_foreign"]);
    await expect(ProjectDerivationStore.activate(runtimePool(), operation)).rejects.toMatchObject({
      reason: "binding_mismatch",
    });
    operation = await ProjectDerivationStore.recordReceipt(
      runtimePool(),
      operation,
      "graph",
      graphWrite.graph,
      "graph",
    );
    await setReceiptValue(ownerPool(), GRAPH_PROJECT, "{graph,value,designContract,id}", "design_contract_foreign");
    await expect(ProjectDerivationStore.activate(runtimePool(), operation)).rejects.toMatchObject({
      reason: "binding_mismatch",
    });
    operation = await ProjectDerivationStore.recordReceipt(
      runtimePool(),
      operation,
      "graph",
      graphWrite.graph,
      "graph",
    );
    await ownerPool().query(
      "UPDATE design_contracts SET contract = jsonb_set(contract, '{identity}', to_jsonb('a changed valid identity'::text)) WHERE id = $1",
      [graphWrite.graph.designContract.id],
    );
    await expect(ProjectDerivationStore.activate(runtimePool(), operation)).rejects.toMatchObject({
      reason: "binding_mismatch",
    });
    await ownerPool().query("UPDATE design_contracts SET domain = $2, contract = $3::jsonb WHERE id = $1", [
      graphWrite.graph.designContract.id,
      design.contract.domain,
      JSON.stringify(design.contract),
    ]);
    expect((await ProjectDerivationStore.activate(runtimePool(), operation)).status).toBe("succeeded");
  });
});
