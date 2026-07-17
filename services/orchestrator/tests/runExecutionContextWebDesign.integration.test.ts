// ds-2 production composition proof: a persisted, published web artifact must
// reach the real run-context Writer field. This uses Postgres + the real adapter,
// stores, and run loader — no SQL or context in-memory stub.

import { mkdtemp, rm } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope } from "@tanren/db";
import { parseDesignContract } from "../src/engine/design/designContract.js";
import { FilesystemArtifactStore } from "../src/engine/design/system/artifactStore.js";
import { designContractV2Digest, migrateDesignContractV1ToV2 } from "../src/engine/design/system/designContractV2.js";
import { DesignSystemReleaseStore } from "../src/engine/design/system/designSystemStore.js";
import { resolveDtcgTokens } from "../src/engine/design/system/dtcgResolver.js";
import { WebDesignTargetAdapter } from "../src/engine/design/system/webAdapter.js";
import { DesignContractStore } from "../src/engine/repositories/designContracts.js";
import { loadRunExecutionContext } from "../src/engine/worker/runExecutionContext.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_ID = "org_ds2_writer";
const PROJECT_ID = "project_ds2_writer";
const SPEC_ID = "spec_ds2_writer";
const RUN_ID = "run_ds2_writer";
const SYSTEM_ID = "system_ds2_writer";
const RELEASE_ID = "release_ds2_writer_1";
const ARTIFACT_ID = "artifact_ds2_writer_1";
const ARTIFACT_ROOT_PREFIX = "/tmp/tanren-ds2-writer-context-";
const DIGEST = `sha256:${"a".repeat(64)}`;

function dbName(): string {
  return `tanren_ds2_writer_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

describeDb("run execution context — published web design Writer injection", () => {
  const database = dbName();
  let ownerPool: Pool;
  let runtimePool: Pool;
  let artifactRoot: string;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    runtimePool = new Pool({ connectionString: runtimeUrl(ADMIN_URL, database) });
    artifactRoot = await mkdtemp(ARTIFACT_ROOT_PREFIX);

    await seedRun(ownerPool);
    await publishProjectWebSystem(runtimePool, artifactRoot);
  }, 60_000);

  afterAll(async () => {
    await runtimePool?.end();
    await ownerPool?.end();
    if (artifactRoot !== undefined) await rm(artifactRoot, { recursive: true, force: true });
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  it("injects the persisted web catalog and tokens through loadRunExecutionContext", async () => {
    const loaded = await runWithOrgScope(runtimePool, ORG_ID, (client) =>
      loadRunExecutionContext(client, { runId: RUN_ID, identitySecretRef: "runner/test/identity" }),
    );

    // This is the exact PlannerRunContext consumed by the real Writer prompt
    // assembly, not a manually constructed loadDesignContextBlock input.
    expect(loaded.context.designContextBlock).toContain(
      "Web design system — use this published system when authoring UI",
    );
    expect(loaded.context.designContextBlock).toContain(
      `Design system: ${SYSTEM_ID}; release: ${RELEASE_ID}; artifact: ${ARTIFACT_ID}`,
    );
    expect(loaded.context.designContextBlock).toContain("color.primary: --tanren-color-primary = #155eef");
    expect(loaded.context.designContextBlock).toContain("button (@radix-ui/react-slot; components/ui/button.tsx)");
  });
});

async function seedRun(pool: Pool): Promise<void> {
  const config = {
    version: 1,
    credentials: {
      defaultLlm: { cli: "codex", model: "gpt-5", authRef: "credential/codex/test" },
      githubCredentialRef: "github-test",
    },
  };
  await pool.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [ORG_ID],
  );
  await pool.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, 'Writer injection', 'https://example.test/writer-injection.git', 'main', 'runner:test', $2, $3::jsonb)`,
    [PROJECT_ID, ORG_ID, JSON.stringify(config)],
  );
  await pool.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, acceptance_criteria)
     VALUES ($1, $2, $3, 'Use the design system', 'Author UI from the published web system.', '["uses tokens"]'::jsonb)`,
    [SPEC_ID, PROJECT_ID, ORG_ID],
  );
  await pool.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
     VALUES ($1, $2, $3, $4, 'cli', 'tanren/ds2-writer', 'queued')`,
    [RUN_ID, SPEC_ID, PROJECT_ID, ORG_ID],
  );
}

async function publishProjectWebSystem(pool: Pool, artifactRoot: string): Promise<void> {
  const contract = parseDesignContract({
    version: 1,
    domain: "saas-web",
    identity: "published web system",
    intent: "use the exact projected tokens and components",
  });
  const contractRecord = await runWithOrgScope(pool, ORG_ID, (client) =>
    DesignContractStore.create(client, { orgId: ORG_ID, projectId: PROJECT_ID, contract }, { kind: "operator" }),
  );
  const v2Contract = migrateDesignContractV1ToV2(contract);
  const contractDigest = designContractV2Digest(v2Contract);
  const releases = new DesignSystemReleaseStore(pool);
  await releases.createSystem({ orgId: ORG_ID, id: SYSTEM_ID, slug: "writer-system", name: "Writer System" });
  await releases.createRelease({
    orgId: ORG_ID,
    id: RELEASE_ID,
    designSystemId: SYSTEM_ID,
    version: 1,
    contractId: contractRecord.id,
    contractVersion: contractRecord.version,
    contractDigest,
    manifestSchemaVersion: 1,
    createdBy: "operator_test",
  });
  const adapter = new WebDesignTargetAdapter({
    designSystemId: SYSTEM_ID,
    releaseId: RELEASE_ID,
    tokens: resolveDtcgTokens({
      color: { primary: { $type: "color", $value: "#155eef" } },
      space: { md: { $type: "dimension", $value: { value: 8, unit: "px" } } },
    }),
  });
  await adapter.publish({
    artifactId: ARTIFACT_ID,
    contractDigest,
    plainReleaseDigest: DIGEST,
    polishedReleaseDigest: DIGEST,
    pool,
    artifactStore: new FilesystemArtifactStore(artifactRoot),
    orgId: ORG_ID,
    projectId: PROJECT_ID,
  });
  await runWithOrgScope(pool, ORG_ID, (client) =>
    client.query(
      `UPDATE design_system_releases
          SET state = 'published', canonical_artifact_id = $1, published_by = 'operator_test', published_at = now()
        WHERE org_id = $2 AND id = $3`,
      [ARTIFACT_ID, ORG_ID, RELEASE_ID],
    ),
  );
}
