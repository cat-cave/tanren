// cspell:ignore premerge mainsha scen
// ds-6 real-Postgres / RLS proof (gated on TANREN_RLS_DB_TEST). This is the KEY guard the
// layer-2 audit demanded: it drives the DesignDeliveryProofV1 join END-TO-END through the
// ACTUAL recording path — `DesignAwareDeliveryCoordinator.run({phase:"pre_merge"})` writes
// real `integration_proof_units` rows, and the REAL loaders (`loadPreMergeBinding` /
// `loadProductionActivation`) read them back — NOT hand-injected fabrications. It proves:
//   (a) a fully-matching pre-merge + production → `equivalent` with a NON-EMPTY boundKey
//       (real fragmentDigests) — i.e. the join is LOADABLE end-to-end (Finding 1);
//   (b) a production design artifact ≠ the pre-merge snapshot → blocked (Finding 3, same domain);
//   (c) a production scenario set ≠ the pre-merge matrix → blocked (Finding 2, non-tautological);
//   (d) a production release bound to a different integration node → blocked;
//   (e) a 200-but-failing demo → blocked;
//   and a cross-org read sees ZERO evidence (RLS) → blocked.

import { createHash } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope, resetSystemPool, setSystemPool } from "@tanren/db";
import { DesignAwareDeliveryCoordinator } from "../src/engine/design/queue/designAwareDeliveryCoordinator.js";
import { gatherDesignDeliveryEvidence } from "../src/engine/design/queue/designDeliveryProofReads.js";
import { buildDesignDeliveryProof } from "../src/engine/design/queue/designDeliveryProofGates.js";
import { PgIntegrationProofUnitRepository } from "../src/engine/repositories/integrationProofUnits.js";
import { PgEventStore, type EventStore } from "../src/engine/eventStore.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG = "org_ds6";
const OTHER_ORG = "org_ds6_other";
const SHA = (c: string): string => `sha256:${c.repeat(64)}`;
/** A deterministic distinct sha256 digest per seed string (avoids org+digest unique clashes). */
const digestOf = (seed: string): string => `sha256:${createHash("sha256").update(seed).digest("hex")}`;

function dbName(): string {
  return `tanren_ds6_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
function runtimeUrl(database: string): string {
  const parsed = new URL(ADMIN_URL);
  parsed.username = RUNTIME_ROLE;
  parsed.password = RUNTIME_PASSWORD;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

type QC = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
};

/** The immutable coordinates one delivery scenario drives against. The pre-merge cells are
 * recorded against the project's base render verdict; a negative-control `recompose` callback
 * optionally seeds a LATER divergent render verdict so the production current-state differs. */
interface Scenario {
  readonly project: string;
  readonly node: string;
  readonly releaseNode: string;
  readonly runId: string;
  readonly mergeSha: string;
  readonly demoPassed: number;
  readonly demoFailed: number;
}

function checkpoints(scenarios: readonly string[]): string {
  return JSON.stringify(scenarios.map((s) => ({ checkpointId: s, verdict: "passed", failingRuleIds: [] })));
}

async function seedProject(client: QC, org: string, project: string): Promise<void> {
  await client.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1,$1,'https://example.com/x.git','main','runner:v0',$2,'{"version":1}'::jsonb)`,
    [project, org],
  );
}

/** Seed a design release (system, artifact, release) + a render verdict for it. */
async function seedDesign(
  client: QC,
  org: string,
  project: string,
  sys: string,
  release: string,
  artifactId: string,
  digest: string,
  scenarios: readonly string[],
): Promise<void> {
  await client.query(
    `INSERT INTO design_systems (org_id, id, slug, name, description, lifecycle, default_channel)
     VALUES ($1,$2,$2,'DS','x','active','stable') ON CONFLICT DO NOTHING`,
    [org, sys],
  );
  await client.query(
    `INSERT INTO design_artifacts (org_id, id, design_system_id, digest, media_type, manifest_version, object_store_key, byte_size)
     VALUES ($1,$2,$3,$4,'application/json',1,$5,128)`,
    [org, artifactId, sys, digest, `k/${artifactId}`],
  );
  await client.query(
    `INSERT INTO design_system_releases
       (org_id, id, design_system_id, version, state, contract_id, contract_version, contract_digest,
        manifest_schema_version, canonical_artifact_id, created_by, published_by, published_at)
     VALUES ($1,$2,$3,$4,'published','contract_x',1,$5,1,$6,'seed','op',now())`,
    [org, release, sys, digestVersion(digest), SHA("c"), artifactId],
  );
  await client.query(
    `INSERT INTO design_render_land_verdicts
       (org_id, project_id, id, design_system_id, release_id, design_contract_version, contract_digest,
        accessibility_standard, outcome, checkpoint_count, passed_count, failed_count, inconclusive_count,
        excluded_count, failing_scenario_key, failing_rule_ids, checkpoints)
     VALUES ($1,$2,$3,$4,$5,'1',$6,'wcag21aa','passed',$7,$7,0,0,0,NULL,'[]'::jsonb,$8::jsonb)`,
    [org, project, `v_${release}`, sys, release, SHA("c"), scenarios.length, checkpoints(scenarios)],
  );
  for (const i of [0, 1]) {
    await client.query(
      `INSERT INTO design_fragments (org_id, id, design_system_id, kind, label, phase, version, digest, conformance_suite_id, body, created_by, status)
       VALUES ($1,$2,$3,'component',$4,'components',$5,$6,'suite','{}'::jsonb,'seed','validated') ON CONFLICT DO NOTHING`,
      [
        org,
        `frag_${sys}_${String(i)}`,
        sys,
        `l_${sys}_${String(i)}`,
        `1.${String(i)}`,
        digestOf(`frag:${sys}:${String(i)}`),
      ],
    );
  }
}

async function seedProduction(client: QC, org: string, s: Scenario): Promise<void> {
  // A run lineage row so the events' (org_id, run_id) FK resolves.
  await client.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
     VALUES ($1,$2,$3,'t','d','in_flight')`,
    [`spec_${s.project}`, s.project, org],
  );
  await client.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
     VALUES ($1,$2,$3,$4,'ci','main','completed')`,
    [s.runId, `spec_${s.project}`, s.project, org],
  );
  await client.query(
    `INSERT INTO cas_artifacts (org_id, digest, byte_size, media_type, storage_backend, inline_bytes)
     VALUES ($1,$2,1,'application/octet-stream','inline_pg',$3) ON CONFLICT DO NOTHING`,
    [org, SHA("b"), Buffer.from([0])],
  );
  await client.query(
    `INSERT INTO release_instances
       (org_id, id, project_id, provider, app_id, environment, deployment_id, source_ref, artifact_digest,
        integration_node_id, url, state)
     VALUES ($1,$2,$3,'fly','app1','production',$4,$5,$6,$7,'https://x','live')`,
    [org, `ri_${s.project}`, s.project, `dep_${s.project}`, s.mergeSha, SHA("b"), s.releaseNode],
  );
  // Events written through the REAL PgEventStore (the single-event-writer authority) on the
  // org-scoped client — schema-validated + RLS-checked, never a raw INSERT.
  const eventStore = new PgEventStore(client as unknown as ConstructorParameters<typeof PgEventStore>[0]);
  await eventStore.append({
    orgId: org,
    runId: s.runId,
    projectId: s.project,
    eventType: "merge.completed",
    payload: { prUrl: "https://example.com/pull/1", prNumber: 1, integration: "native_queue", mergeSha: s.mergeSha },
  });
  await eventStore.append({
    orgId: org,
    runId: s.runId,
    projectId: s.project,
    eventType: "deploy.verified",
    payload: {
      provider: "deploy.flyio",
      appId: "app1",
      deploymentId: `dep_${s.project}`,
      url: "https://example.com",
      state: "READY",
      smokeStatus: 200,
    },
  });
  await eventStore.append({
    orgId: org,
    runId: s.runId,
    projectId: s.project,
    eventType: "demo.completed",
    payload: {
      surfaceKind: "web_url",
      behaviorCount: s.demoPassed + s.demoFailed,
      passed: s.demoPassed,
      failed: s.demoFailed,
    },
  });
}

describeDb("ds-6 DesignDeliveryProofV1 join — real DB / RLS end-to-end", () => {
  const database = dbName();
  let ownerPool: Pool;
  let runtimePool: Pool;
  const events: EventStore = { append: async () => {}, appendIfAbsent: async () => "" } as unknown as EventStore;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();
    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    runtimePool = new Pool({ connectionString: runtimeUrl(database) });
    setSystemPool(ownerPool);
    await ownerPool.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1,'oidc',$1,$1,$1,'{"version":1}'::jsonb),($2,'oidc',$2,$2,$2,'{"version":1}'::jsonb)`,
      [ORG, OTHER_ORG],
    );
  }, 60_000);

  afterAll(async () => {
    resetSystemPool();
    await runtimePool?.end();
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  /** Record pre-merge cells through the REAL coordinator, then gather + build the proof
   * through the REAL loaders. `recompose` optionally seeds a later divergent render verdict
   * AFTER cells are recorded (so the pre-merge snapshot and production current-state differ). */
  async function driveJoin(
    s: Scenario,
    recompose?: (client: QC) => Promise<void>,
  ): Promise<Awaited<ReturnType<typeof buildDesignDeliveryProof>>> {
    const sys = `sys_${s.project}`;
    await runWithOrgScope(ownerPool, ORG, async (client) => {
      await seedProject(client, ORG, s.project);
      await seedDesign(client, ORG, s.project, sys, `rel_${s.project}`, `art_${s.project}`, baseDigest(s.project), [
        "s1",
        "s2",
      ]);
      await seedProduction(client, ORG, s);
    });
    // REAL recording path: the coordinator reads the (latest) render verdict + records cells.
    const coordinator = new DesignAwareDeliveryCoordinator({
      pool: runtimePool,
      eventStore: events,
      proofUnits: new PgIntegrationProofUnitRepository(runtimePool),
    });
    await coordinator.run({
      phase: "pre_merge",
      orgId: ORG,
      projectId: s.project,
      integrationNodeId: s.node,
      runId: s.runId,
    });
    if (recompose !== undefined) await runWithOrgScope(ownerPool, ORG, (client) => recompose(client));
    const evidence = await gatherDesignDeliveryEvidence(
      runtimePool,
      { orgId: ORG, projectId: s.project, runId: s.runId, mergeSha: s.mergeSha },
      s.node,
    );
    return buildDesignDeliveryProof(evidence);
  }

  it("(a) POSITIVE — a fully-matching join is `equivalent` with a NON-EMPTY real boundKey (loadable end-to-end)", async () => {
    const proof = await driveJoin({
      project: "p_pos",
      node: "node_pos",
      releaseNode: "node_pos",
      runId: "run_pos",
      mergeSha: "mainsha_pos",
      demoPassed: 2,
      demoFailed: 0,
    });
    expect(proof.equivalence).toBe("equivalent");
    expect(proof.preMerge?.cells).toHaveLength(2);
    // Finding 4: the proven six-tuple carries the REAL validated fragment digests (never []).
    const frags = proof.boundKey?.fragmentDigests ?? [];
    expect(frags).toHaveLength(2);
    expect(frags.every((d) => /^sha256:[0-9a-f]{64}$/u.test(d))).toBe(true);
    expect([...frags]).toEqual([...frags].sort());
    expect(proof.production?.scenarioKeys).toEqual(["s1", "s2"]);
  });

  it("(b) NEGATIVE — a production design artifact ≠ pre-merge snapshot → blocked_artifact_mismatch", async () => {
    const proof = await driveJoin(
      {
        project: "p_art",
        node: "node_art",
        releaseNode: "node_art",
        runId: "run_art",
        mergeSha: "mainsha_art",
        demoPassed: 2,
        demoFailed: 0,
      },
      async (client) => {
        // A LATER recompose to a DIFFERENT design artifact (the deployed/current design changed).
        await seedDesign(client, ORG, "p_art", "sys_p_art", "rel_p_art_2", "art_p_art_2", digestOf("design2:p_art"), [
          "s1",
          "s2",
        ]);
      },
    );
    expect(proof.equivalence).toBe("blocked_artifact_mismatch");
    expect(proof.boundKey).toBeNull();
  });

  it("(c) NEGATIVE — a production scenario set ≠ pre-merge matrix → blocked_scenario_mismatch", async () => {
    const proof = await driveJoin(
      {
        project: "p_scen",
        node: "node_scen",
        releaseNode: "node_scen",
        runId: "run_scen",
        mergeSha: "mainsha_scen",
        demoPassed: 2,
        demoFailed: 0,
      },
      async (client) => {
        // A later verdict for the SAME artifact but a DIFFERENT scenario set (s1,s3 vs s1,s2).
        await client.query(
          `INSERT INTO design_render_land_verdicts
             (org_id, project_id, id, design_system_id, release_id, design_contract_version, contract_digest,
              accessibility_standard, outcome, checkpoint_count, passed_count, failed_count, inconclusive_count,
              excluded_count, failing_scenario_key, failing_rule_ids, checkpoints)
           VALUES ($1,$2,$3,$4,$5,'1',$6,'wcag21aa','passed',2,2,0,0,0,NULL,'[]'::jsonb,$7::jsonb)`,
          [ORG, "p_scen", "v_rel_p_scen_2", "sys_p_scen", "rel_p_scen", SHA("c"), checkpoints(["s1", "s3"])],
        );
      },
    );
    expect(proof.equivalence).toBe("blocked_scenario_mismatch");
  });

  it("(d) NEGATIVE — a production release bound to a different integration node → blocked_node_mismatch", async () => {
    const proof = await driveJoin({
      project: "p_node",
      node: "node_pre",
      releaseNode: "node_deployed_other",
      runId: "run_node",
      mergeSha: "mainsha_node",
      demoPassed: 2,
      demoFailed: 0,
    });
    expect(proof.equivalence).toBe("blocked_node_mismatch");
  });

  it("(e) NEGATIVE — a 200-but-failing demo → blocked_demo_not_passed", async () => {
    const proof = await driveJoin({
      project: "p_demo",
      node: "node_demo",
      releaseNode: "node_demo",
      runId: "run_demo",
      mergeSha: "mainsha_demo",
      demoPassed: 1,
      demoFailed: 1,
    });
    expect(proof.equivalence).toBe("blocked_demo_not_passed");
  });

  it("cross-org — org B sees ZERO of org A's evidence (RLS) → blocked", async () => {
    // Reuse p_pos's node under OTHER_ORG scope: RLS confines the read to org B (no rows).
    const evidence = await gatherDesignDeliveryEvidence(
      runtimePool,
      { orgId: OTHER_ORG, projectId: "p_pos", runId: "run_pos", mergeSha: "mainsha_pos" },
      "node_pos",
    );
    const proof = buildDesignDeliveryProof(evidence);
    expect(proof.preMerge).toBeNull();
    expect(proof.equivalence).toBe("blocked_pre_merge_incomplete");
  });
});

/** A tiny deterministic version derived from a digest tail (releases need a unique version). */
function digestVersion(digest: string): number {
  return (Number.parseInt(digest.slice(-4), 16) % 1000) + 1;
}

/** The per-project SNAPSHOT design-artifact digest the pre-merge cells bind against. */
function baseDigest(project: string): string {
  return digestOf(`design:${project}`);
}
