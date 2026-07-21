// ds-7 — FRAMEWORK ADAPTER CONFORMANCE RLS: same-org record/read round-trip +
// cross-org DENIAL. Gated behind TANREN_RLS_DB_TEST=1 + owner DATABASE_URL,
// mirroring designStudioReuse.rls.integration.test.ts. Proves a conformance run
// records + reads under the owning org, while org B / the unscoped runtime pool
// see ZERO rows (deny-by-default + FORCE RLS). The composite FKs forbid a
// cross-org artifact reference even if an application check regresses.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope } from "@tanren/db";
import { DesignAdapterConformanceStore } from "../src/engine/design/system/adapterConformanceStore.js";
import {
  type DesignAdapterConformanceReceiptV1,
  designAdapterConformanceReceiptDigest,
} from "../src/engine/design/system/adapterConformanceReceipt.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

function dbName(): string {
  return `tanren_ds7_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
function runtimeUrl(adminUrl: string, database: string): string {
  const parsed = new URL(adminUrl);
  parsed.username = RUNTIME_ROLE;
  parsed.password = RUNTIME_PASSWORD;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const ORG_A = "org_ds7_a";
const ORG_B = "org_ds7_b";
const PROJECT_A = "project_ds7_a";
const PROJECT_B = "project_ds7_b";
const SYSTEM = "system_ds7";
const RELEASE = "release_ds7";
const ARTIFACT = "artifact_ds7";
const CONTRACT_DIGEST = `sha256:${"a".repeat(64)}`;
const ARTIFACT_DIGEST = `sha256:${"c".repeat(64)}`;
const MANIFEST_BYTES = new TextEncoder().encode(
  `${JSON.stringify(
    {
      manifestVersion: 1,
      artifactId: ARTIFACT,
      releaseId: RELEASE,
      target: "bevy",
      contractDigest: CONTRACT_DIGEST,
      plainReleaseDigest: `sha256:${"0".repeat(64)}`,
      polishedReleaseDigest: `sha256:${"1".repeat(64)}`,
      files: [],
      fragmentLineage: [],
      exports: [],
      proofDigests: {},
    },
    null,
    2,
  )}\n`,
);

function buildReceipt(input: {
  readonly target: DesignAdapterConformanceReceiptV1["target"];
  readonly artifactDigest: string;
  readonly requiredCapabilities: readonly string[];
}): DesignAdapterConformanceReceiptV1 {
  return {
    version: 1,
    schemaVersion: "design_adapter_conformance.v1",
    target: input.target,
    adapterVersion: `tanren.${input.target}.v1`,
    artifactDigest: input.artifactDigest,
    scenarioMatrixDigest: `sha256:${"2".repeat(64)}`,
    requiredCapabilities: [...input.requiredCapabilities],
    resolvedCapabilities: input.requiredCapabilities.map((capability) => ({
      capability,
      supported: true,
      evidenceDigest: input.artifactDigest,
    })),
    criticalProofs: [
      { key: `${input.target}.build`, kind: "build", evidenceDigest: input.artifactDigest, passed: true },
      { key: `${input.target}.tokens`, kind: "token", evidenceDigest: input.artifactDigest, passed: true },
      { key: `${input.target}.render`, kind: "render", evidenceDigest: input.artifactDigest, passed: true },
      { key: `${input.target}.export`, kind: "export", evidenceDigest: input.artifactDigest, passed: true },
    ],
    positiveCases: [
      {
        key: `${input.target}.tokens.resolve`,
        description: "tokens resolve",
        evidenceDigest: input.artifactDigest,
        passed: true,
      },
    ],
    negativeControls: [
      {
        key: `${input.target}.missing.token_file`,
        description: "missing token file is flagged",
        expectFindingCode: `${input.target}.artifact_file_missing`,
        passed: true,
      },
    ],
    outcome: "passed",
    notes: "",
  };
}

describeDb("frameworkAdapterConformance.rls — org isolation", () => {
  const database = dbName();
  let ownerPool: Pool;
  let runtimePool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    runtimePool = new Pool({ connectionString: runtimeUrl(ADMIN_URL, database) });

    for (const orgId of [ORG_A, ORG_B]) {
      await ownerPool.query(
        `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
         VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
        [orgId],
      );
    }
    for (const [orgId, projectId] of [
      [ORG_A, PROJECT_A],
      [ORG_B, PROJECT_B],
    ]) {
      await ownerPool.query(
        `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
         VALUES ($1, $2, 'https://example.test/x.git', 'main', 'runner:test', $3, '{"version":1}'::jsonb)`,
        [projectId, projectId, orgId],
      );
      // Seed a design system + release + artifact per org so the conformance FKs resolve.
      await runWithOrgScope(runtimePool, orgId, (client) =>
        client.query(`INSERT INTO design_systems (org_id, id, slug, name) VALUES ($1, $2, $3, $4)`, [
          orgId,
          SYSTEM,
          `slug-${orgId}`,
          `System ${orgId}`,
        ]),
      );
      await runWithOrgScope(runtimePool, orgId, (client) =>
        client.query(
          `INSERT INTO design_system_releases
             (org_id, id, design_system_id, version, state, contract_id, contract_version,
              contract_digest, manifest_schema_version, created_by)
           VALUES ($1, $2, $3, 1, 'draft', 'contract_x', 1, $4, 1, 'tester')`,
          [orgId, RELEASE, SYSTEM, CONTRACT_DIGEST],
        ),
      );
      // The artifact row's `digest` is the CAS manifest digest; the conformance run
      // references it. Both the artifact and the conformance run are org-scoped.
      const artifactDigest = `${ARTIFACT_DIGEST.slice(0, -1)}${orgId === ORG_A ? "a" : "b"}`;
      await runWithOrgScope(runtimePool, orgId, (client) =>
        client.query(
          `INSERT INTO design_artifacts
             (org_id, id, design_system_id, digest, media_type, manifest_version, object_store_key, byte_size)
           VALUES ($1, $2, $3, $4, 'application/vnd.tanren.design-artifact.v1+json', 1, $5, $6)`,
          [
            orgId,
            ARTIFACT,
            SYSTEM,
            artifactDigest,
            `sha256/${artifactDigest.slice("sha256:".length, "sha256:".length + 2)}/${artifactDigest.slice("sha256:".length)}`,
            MANIFEST_BYTES.byteLength,
          ],
        ),
      );
    }
  }, 60_000);

  afterAll(async () => {
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

  it("records a passed conformance run under ORG_A and reads it back same-org", async () => {
    const store = new DesignAdapterConformanceStore(runtimePool);
    const artifactDigest = `${ARTIFACT_DIGEST.slice(0, -1)}a`;
    const receipt = buildReceipt({
      target: "bevy",
      artifactDigest,
      requiredCapabilities: ["tokens", "catalog", "bevy-ui"],
    });
    const recorded = await store.record({
      orgId: ORG_A,
      projectId: PROJECT_A,
      id: "run_bevy_a",
      releaseId: RELEASE,
      artifactId: ARTIFACT,
      target: "bevy",
      adapterVersion: "tanren.bevy.v1",
      artifactDigest,
      receipt,
    });
    expect(recorded.outcome).toBe("passed");
    expect(recorded.receipt).toBeDefined();
    expect(recorded.receipt?.requiredCapabilities).toEqual(["tokens", "catalog", "bevy-ui"]);
    // The persisted receipt digest matches the canonical digest of the receipt body.
    expect(recorded.receiptDigest).toBe(designAdapterConformanceReceiptDigest(recorded.receipt!));

    // Same-org read resolves the row.
    const latest = await store.readLatest(ORG_A, PROJECT_A, "bevy");
    expect(latest).toBeDefined();
    expect(latest?.id).toBe("run_bevy_a");
    expect(latest?.outcome).toBe("passed");
  });

  it("cross-org read returns ZERO rows (deny-by-default + FORCE RLS)", async () => {
    const store = new DesignAdapterConformanceStore(runtimePool);
    // ORG_B reads for its own project — sees nothing (ORG_A's row is invisible).
    const crossRead = await store.readLatest(ORG_B, PROJECT_B, "bevy");
    expect(crossRead).toBeUndefined();
    // ORG_B's project list is empty.
    const list = await store.listForProject(ORG_B, PROJECT_B);
    expect(list).toEqual([]);
  });

  it("cross-org direct INSERT is REJECTED by RLS (noforge org_id mismatch)", async () => {
    // A direct INSERT under ORG_B's scope for ORG_A's project fails — RLS WITH CHECK.
    await expect(
      runWithOrgScope(runtimePool, ORG_B, (client) =>
        client.query(
          `INSERT INTO design_adapter_conformance_runs
             (org_id, project_id, id, release_id, artifact_id, target, adapter_version,
              artifact_digest, receipt_digest, outcome)
           VALUES ($1, $2, 'run_forge', $3, $4, 'bevy', 'tanren.bevy.v1', $5, $6, 'failed')`,
          [
            ORG_A,
            PROJECT_A,
            RELEASE,
            ARTIFACT,
            ARTIFACT_DIGEST,
            designAdapterConformanceReceiptDigest(
              buildReceipt({ target: "bevy", artifactDigest: ARTIFACT_DIGEST, requiredCapabilities: ["tokens"] }),
            ),
          ],
        ),
      ),
    ).rejects.toThrow(/new row violates row-level security/u);
  });

  it("unscoped runtime pool sees ZERO rows (no GUC = deny-by-default)", async () => {
    // No org scope set: a raw query from the runtime pool returns ZERO rows.
    const result = await runtimePool.query("SELECT id FROM design_adapter_conformance_runs WHERE target = $1", [
      "bevy",
    ]);
    expect(result.rows).toEqual([]);
  });

  it("a doctored receipt that claims 'passed' but fails the positive-only predicate is rewritten to 'failed'", async () => {
    // A receipt body whose outcome label says 'passed' but whose negativeControls
    // do not all pass is rewritten to 'failed' BEFORE the row is written — the
    // CHECK constraint's `passed requires receipt` guard plus this rewrite mean a
    // doctored body can never produce a 'passed' row.
    const store = new DesignAdapterConformanceStore(runtimePool);
    const artifactDigest = `${ARTIFACT_DIGEST.slice(0, -1)}a`;
    const badReceipt = buildReceipt({
      target: "swiftui",
      artifactDigest,
      requiredCapabilities: ["tokens"],
    });
    // Tamper: a negative control the validator did NOT catch.
    badReceipt.negativeControls[0]!.passed = false;
    badReceipt.outcome = "passed";
    const recorded = await store.record({
      orgId: ORG_A,
      projectId: PROJECT_A,
      id: "run_swiftui_doctored",
      releaseId: RELEASE,
      artifactId: ARTIFACT,
      target: "swiftui",
      adapterVersion: "tanren.swiftui.v1",
      artifactDigest,
      receipt: badReceipt,
    });
    expect(recorded.outcome).toBe("failed");
  });
});
