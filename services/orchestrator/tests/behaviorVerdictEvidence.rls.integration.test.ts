// cspell:ignore venv vcap
// rv-9 FINDING 2 real-Postgres proof: the durable verdict -> capture linkage
// (behavior_verdict_evidence, migration 0091). Gated on TANREN_RLS_DB_TEST; every decisive write
// runs as the non-superuser tanren_app role. It proves a captured artifact's address is resolvable
// from the durable ledger by verdict id ALONE (not the ephemeral run result), that an orphan link
// (no artifact row) is rejected fail-closed, that cross-org readers see ZERO, and that the ledger
// links are append-only.
import { migrate, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentDigestOf, parseDigest, type Digest } from "../src/engine/contracts/cas.js";
import { PgCasByteStore } from "../src/engine/cas/pgCasByteStore.js";
import {
  PgAcceptanceRunStore,
  PgVerificationCaptureStore,
  type RecordAcceptanceVerdictInput,
} from "../src/engine/verification/acceptance/index.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG = "org_verdict_evidence";
const OTHER_ORG = "org_verdict_evidence_other";
const PROJECT = "project_verdict_evidence";
const D = `sha256:${"c".repeat(64)}`;
const CAS = `sha256:${"a".repeat(64)}`;
const RUN_ID = "verdict_evidence_run";
const ENV_ID = "venv_verdict_evidence";
const NODE_ID = "inode_verdict_evidence";
const BEHAVIOR_REVISION = "br_verdict_evidence";
const PERSONA_REVISION = "pr_verdict_evidence";

function databaseName(): string {
  return `tanren_verdict_evidence_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [OTHER_ORG],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, $1, 'https://example.com/repo.git', 'main', 'runner:v0', $2, '{}'::jsonb)`,
    [PROJECT, ORG],
  );
  await owner.query(
    `INSERT INTO integration_nodes (node_id, project_id, org_id, base_branch, base_sha, ref, purpose, member_key)
     VALUES ($1, $2, $3, 'main', $4, 'refs/heads/main', 'merge_batch', 'member-evidence')`,
    [NODE_ID, PROJECT, ORG, D],
  );
  await owner.query(
    `INSERT INTO cas_artifacts (org_id, digest, byte_size, media_type, storage_backend, inline_bytes)
     VALUES ($1, $2, 0, 'application/octet-stream', 'inline_pg', $3)`,
    [ORG, CAS, Buffer.from([0])],
  );
  await owner.query(
    `INSERT INTO persona_revisions (id, org_id, project_id, persona_id, scope, revision_number, name, description, content_digest)
     VALUES ($1, $2, $3, 'persona', 'project', 1, 'persona', 'persona', $4)`,
    [PERSONA_REVISION, ORG, PROJECT, D],
  );
  await owner.query(
    `INSERT INTO behavior_revisions (id, org_id, project_id, behavior_id, persona_revision_id, revision_number, title, given, "when", "then", content_digest)
     VALUES ($1, $2, $3, 'behavior', $4, 1, 'behavior', 'g', 'w', 't', $5)`,
    [BEHAVIOR_REVISION, ORG, PROJECT, PERSONA_REVISION, D],
  );
  await owner.query(
    `INSERT INTO verification_environments (org_id, id, project_id, integration_node_id, artifact_digest, deployment_target, environment_fingerprint, tenant_lease_id, lifecycle_status)
     VALUES ($1, $2, $3, $4, $5, 'container', $6, $6, 'ready')`,
    [ORG, ENV_ID, PROJECT, NODE_ID, CAS, D],
  );
  await owner.query(
    `INSERT INTO behavior_verification_runs (org_id, id, project_id, purpose, environment_id, prepared_head_sha, jj_tree_id, plan_set_hash, runtime_behavior_context_hash, artifact_digest, status, policy)
     VALUES ($1, $2, $3, 'manual_canary', $4, $5, $5, $5, $5, $6, 'running', '{}'::jsonb)`,
    [ORG, RUN_ID, PROJECT, ENV_ID, D, CAS],
  );
}

function verdictInput(
  overrides: Partial<RecordAcceptanceVerdictInput> & Pick<RecordAcceptanceVerdictInput, "evidenceLinks">,
): RecordAcceptanceVerdictInput {
  return {
    orgId: ORG,
    projectId: PROJECT,
    runId: RUN_ID,
    behaviorRevisionId: BEHAVIOR_REVISION,
    exampleHash: D,
    matrixHash: D,
    requiredAssertionCount: 1,
    executedAssertionCount: 1,
    outcome: "passed",
    attemptCount: 1,
    flakeState: "stable",
    gateEffect: "blocking",
    artifactDigest: parseDigest(CAS),
    runtimeBehaviorContextHash: parseDigest(D),
    assertionEvidence: [{ assertionId: "a1", executed: true, passed: true }],
    attemptEvidence: [{ attemptOrdinal: 1, outcome: "passed" }],
    ...overrides,
  };
}

describeDb("rv-9 behavior_verdict_evidence — durable capture linkage (FINDING 2)", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;
  let store: PgAcceptanceRunStore;
  let captures: PgVerificationCaptureStore;
  const captureBytes = new TextEncoder().encode(JSON.stringify({ probes: [{ probeId: "p1", status: 200 }] }));
  const captureDigest: Digest = contentDigestOf(captureBytes);
  let verdictId: string;
  let capturedArtifactId: string;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: connectionUrl(database) });
    await migrate(owner);
    app = new Pool({ connectionString: connectionUrl(database, { user: APP_ROLE, password: APP_PASSWORD }) });
    await seedTenant(owner);
    store = new PgAcceptanceRunStore(app);
    captures = new PgVerificationCaptureStore(app, new PgCasByteStore(app));
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

  it("records the verdict + durably links its content-addressed capture in one transaction", async () => {
    const captured = await captures.capture({
      orgId: ORG,
      projectId: PROJECT,
      kind: "response_capture",
      mediaType: "application/json",
      bytes: captureBytes,
      redactionClass: "sensitive",
    });
    expect(captured.casDigest).toBe(captureDigest);
    capturedArtifactId = captured.verificationArtifactId;
    verdictId = await store.recordVerdict(
      verdictInput({
        evidenceLinks: [
          {
            verificationArtifactId: captured.verificationArtifactId,
            casDigest: captured.casDigest,
            mediaType: captured.mediaType,
          },
        ],
      }),
    );
    expect(verdictId).toMatch(/^verdict_/u);
  });

  it("resolves the capture address from the LEDGER by verdict id alone (not the ephemeral result)", async () => {
    const links = await store.listVerdictEvidence({ orgId: ORG, verdictId });
    expect(links).toHaveLength(1);
    expect(links[0]).toEqual({
      ordinal: 0,
      verificationArtifactId: capturedArtifactId,
      casDigest: captureDigest,
      mediaType: "application/json",
    });
    // The ledger link is sufficient to fetch the verified bytes back — a later proof needs
    // nothing but the verdict id to reach the content-addressed capture.
    const readBack = await captures.read({ orgId: ORG, verificationArtifactId: links[0]!.verificationArtifactId });
    expect(readBack.bytes).toEqual(captureBytes);
  });

  it("FAIL-CLOSED: an evidence link to an absent artifact is rejected (no orphan linkage)", async () => {
    await expect(
      store.recordVerdict(
        verdictInput({
          evidenceLinks: [
            {
              verificationArtifactId: "vcap_does_not_exist" as never,
              casDigest: parseDigest(`sha256:${"e".repeat(64)}`),
              mediaType: "application/json",
            },
          ],
        }),
      ),
    ).rejects.toThrow(/behavior_verdict_evidence_artifact_fk|foreign key/iu);
  });

  it("CROSS-ORG ZERO: another org cannot see the verdict's evidence links", async () => {
    const foreign = await runWithOrgScope(app, OTHER_ORG, (client) =>
      client.query("SELECT verification_artifact_id FROM behavior_verdict_evidence WHERE verdict_id = $1", [verdictId]),
    );
    expect(foreign.rowCount ?? 0).toBe(0);
    const own = await runWithOrgScope(app, ORG, (client) =>
      client.query("SELECT verification_artifact_id FROM behavior_verdict_evidence WHERE verdict_id = $1", [verdictId]),
    );
    expect(own.rowCount).toBe(1);
  });

  it("the ledger link is append-only — UPDATE and DELETE are rejected", async () => {
    await expect(
      runWithOrgScope(app, ORG, (client) =>
        client.query("UPDATE behavior_verdict_evidence SET media_type = 'x' WHERE org_id = $1 AND verdict_id = $2", [
          ORG,
          verdictId,
        ]),
      ),
    ).rejects.toThrow(/immutable.*append-only.*UPDATE rejected/iu);
    await expect(
      runWithOrgScope(app, ORG, (client) =>
        client.query("DELETE FROM behavior_verdict_evidence WHERE org_id = $1 AND verdict_id = $2", [ORG, verdictId]),
      ),
    ).rejects.toThrow(/immutable.*append-only.*DELETE rejected/iu);
  });
});
