// ds-7 — multi-target composition end-to-end. Drives the REAL production
// producer (`composeProjectTargetDesignSystems`) over Postgres against a
// project whose HEAD design contract declares BOTH web-react AND a non-web
// target (bevy). Proves:
//   · The derive→registry→non-web adapter path FIRES in a real run (trap #1).
//   · The non-web artifact is persisted to the org-scoped artifact tables.
//   · A `passed` conformance receipt is recorded for the EXACT artifact+matrix
//     digest (proof≡effect, trap #7).
//   · The gate-readable view (conformance panel) returns the receipt.
//
// Gated behind TANREN_RLS_DB_TEST=1 + owner/superuser DATABASE_URL, mirroring
// composeProjectTargetDesignSystems.integration.test.ts.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope } from "@tanren/db";
import type { EventStore } from "../src/engine/eventStore.js";
import type { AnswererAdapter } from "../src/engine/providers/types.js";
import { parseDesignContract } from "../src/engine/design/designContract.js";
import { FilesystemArtifactStore } from "../src/engine/design/system/artifactStore.js";
import { composeProjectTargetDesignSystems } from "../src/engine/design/system/composeProjectTargetDesignSystems.js";
import { DesignAdapterConformanceStore } from "../src/engine/design/system/adapterConformanceStore.js";
import { resolveProjectWebDesignSystem } from "../src/engine/design/system/designSystemStore.js";
import type { DesignFragmentDraftV1 } from "../src/engine/design/system/authoring/index.js";
import { DesignContractStore } from "../src/engine/repositories/designContracts.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_ID = "org_ds7_multi";
const PROJECT_ID = "project_ds7_multi";

function dbName(): string {
  return `tanren_ds7_multi_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

class CapturingEventStore implements EventStore {
  readonly appended: Array<{ eventType: string; orgId: string; projectId?: string }> = [];
  async append(input: { eventType: string; orgId: string; projectId?: string }): Promise<void> {
    this.appended.push({ eventType: input.eventType, orgId: input.orgId, projectId: input.projectId });
  }
}

function fixtureFragmentAnswerer(): AnswererAdapter<DesignFragmentDraftV1> {
  return {
    kind: "answerer",
    cli: "fake",
    authRef: "test/ds7-multi-fixture",
    async runAnswerer(opts) {
      const prompt = opts.prompt;
      const kind = /kind:\s+(\S+)/u.exec(prompt)?.[1] ?? "surface/components";
      const label = /label:\s+(.+)/u.exec(prompt)?.[1]?.trim() ?? "Components";
      const phase = /phase:\s+(\S+)/u.exec(prompt)?.[1] ?? "patterns-and-templates";
      const conformanceSuiteId =
        /conformanceSuiteId \(declare verbatim\): (.+)/u.exec(prompt)?.[1]?.trim() ??
        "surface.components.conformance.v1";
      const draft = {
        kind,
        label,
        phase,
        version: "1.0.0",
        targetCapabilities: ["shadcn"],
        requires: [],
        provides: [],
        dependsOn: [],
        conflicts: [],
        replaces: [],
        personaRefs: [],
        behaviorRefs: [],
        conformanceSuiteId,
        operations: [
          {
            operation: "addComponent",
            path: `components/${label}.tsx`,
            fileKind: "component-source",
            mediaType: "text/plain",
            content: "export const Composed = () => null;",
            executable: false,
          },
        ],
      };
      return opts.outputSchema.parse(draft);
    },
  };
}

describeDb("composeProjectTargetDesignSystems — multi-target composition (web + bevy)", () => {
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
    artifactRoot = await mkdtemp(join(tmpdir(), "tanren-ds7-multi-"));

    await ownerPool.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
      [ORG_ID],
    );
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
       VALUES ($1, 'DS Multi', 'https://example.test/ds-multi.git', 'main', 'runner:test', $2, '{"version":1}'::jsonb)`,
      [PROJECT_ID, ORG_ID],
    );
    // Seed a HEAD contract with ONE dimension → one desired surface. The default
    // V2 profile is web-react; the test overrides targetProfiles below to ALSO
    // declare bevy as a required target.
    const contract = parseDesignContract({
      version: 1,
      domain: "saas-web",
      identity: "a multi-platform surface",
      intent: "compose web + native from one design language",
      dimensions: [
        { key: "components", label: "Components", intent: "composable primitives", guidance: "", personaRefs: [] },
      ],
    });
    await runWithOrgScope(runtimePool, ORG_ID, (client) =>
      DesignContractStore.create(client, { orgId: ORG_ID, projectId: PROJECT_ID, contract }, { kind: "operator" }),
    );
    // Override the contract's jsonb to carry targetProfiles = [web-react, bevy].
    // The V1 parser rejects targetProfiles (it's a V2-only field), so mutate the
    // persisted jsonb directly: a future full-V2 capture would persist this
    // shape natively. This mirrors how `withDerivedDesiredSurfaces` would
    // produce V2 targetProfiles from a designed intent. We ALSO update version
    // to 2 so the jsonb parses as a valid V2 capture.
    await runWithOrgScope(runtimePool, ORG_ID, (client) =>
      client.query(
        `UPDATE design_contracts
            SET contract = jsonb_set(contract, '{targetProfiles}', $1::jsonb)
          WHERE org_id = $2 AND project_id = $3`,
        [
          JSON.stringify([
            { target: "web-react", capabilities: [], required: true },
            {
              target: "bevy",
              capabilities: ["tokens", "catalog", "components", "bevy-ui", "bevy-asset", "cargo"],
              required: true,
            },
          ]),
          ORG_ID,
          PROJECT_ID,
        ],
      ),
    );
    await runWithOrgScope(runtimePool, ORG_ID, (client) =>
      client.query(
        `UPDATE design_contracts SET contract = jsonb_set(contract, '{version}', '2'::jsonb) WHERE org_id = $1 AND project_id = $2`,
        [ORG_ID, PROJECT_ID],
      ),
    );
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

  it("composes web-react + bevy, persists both artifacts, records both receipts, and the gate-readable view serves them", async () => {
    const events = new CapturingEventStore();
    const result = await composeProjectTargetDesignSystems(
      {
        pool: runtimePool,
        artifactStore: new FilesystemArtifactStore(artifactRoot),
        fragmentAnswerer: fixtureFragmentAnswerer(),
        eventStore: events,
        createdBy: "tanren.ds7-multi.test",
      },
      { orgId: ORG_ID, projectId: PROJECT_ID },
    );

    expect(result).toBeDefined();
    expect(result?.alreadyPublished).toBe(false);
    // BOTH required targets fired — web-react AND bevy.
    expect(result?.targets.map((target) => target.target).sort()).toEqual(["bevy", "web-react"]);
    for (const outcome of result?.targets ?? []) {
      expect(outcome.conformanceOutcome).toBe("passed");
      expect(outcome.artifactDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    }

    // The release is PUBLISHED with the web artifact as canonical.
    const release = await runWithOrgScope(runtimePool, ORG_ID, (client) =>
      client.query<{ state: string; canonical_artifact_id: string }>(
        "SELECT state, canonical_artifact_id FROM design_system_releases WHERE org_id = $1 AND id = $2",
        [ORG_ID, result!.releaseId],
      ),
    );
    expect(release.rows[0]?.state).toBe("published");
    expect(release.rows[0]?.canonical_artifact_id).toBe(result!.canonicalArtifactId);

    // Both target artifacts persisted.
    const artifacts = await runWithOrgScope(runtimePool, ORG_ID, (client) =>
      client.query<{ id: string; digest: string }>(
        "SELECT id, digest FROM design_artifacts WHERE org_id = $1 AND design_system_id = $2",
        [ORG_ID, result!.designSystemId],
      ),
    );
    expect(artifacts.rows.length).toBeGreaterThanOrEqual(2);

    // The conformance runs are persisted for BOTH targets. ReadLatest returns
    // the passed row for each. Proof≡effect (trap #7): each receipt's
    // artifactDigest matches the persisted artifact row's digest.
    const store = new DesignAdapterConformanceStore(runtimePool);
    for (const outcome of result?.targets ?? []) {
      const row = await store.readLatest(ORG_ID, PROJECT_ID, outcome.target);
      expect(row).toBeDefined();
      expect(row?.outcome).toBe("passed");
      expect(row?.artifactDigest).toBe(outcome.artifactDigest);
      const matchingArtifact = artifacts.rows.find((candidate) => candidate.digest === outcome.artifactDigest);
      expect(matchingArtifact).toBeDefined();
    }

    // The conformance panel returns BOTH targets.
    const panelRows = await store.listForProject(ORG_ID, PROJECT_ID);
    expect(panelRows.map((row) => row.target).sort()).toEqual(["bevy", "web-react"]);

    // THE READER LIGHTS UP — the run-context resolver now resolves a context.
    const resolved = await runWithOrgScope(runtimePool, ORG_ID, (client) =>
      resolveProjectWebDesignSystem(client, { orgId: ORG_ID, projectId: PROJECT_ID }),
    );
    expect(resolved).toBeDefined();
    expect(resolved?.releaseId).toBe(result?.releaseId);
  });

  it("NEGATIVE CONTROL — an unregistered target in the contract is a LOUD typed error (no silent skip)", async () => {
    // Override the contract to declare a target OUTSIDE the frozen adapter union.
    // The composer MUST reject it loudly — never silently compose web-only.
    const FORGED_PROJECT = "project_ds7_multi_forged";
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
       VALUES ($1, 'DS Forged', 'https://example.test/ds-forged.git', 'main', 'runner:test', $2, '{"version":1}'::jsonb)`,
      [FORGED_PROJECT, ORG_ID],
    );
    const contract = parseDesignContract({
      version: 1,
      domain: "saas-web",
      identity: "a forged-target surface",
      intent: "the contract declares an unknown target",
      dimensions: [{ key: "forged", label: "Forged", intent: "composable primitives", guidance: "", personaRefs: [] }],
    });
    await runWithOrgScope(runtimePool, ORG_ID, (client) =>
      DesignContractStore.create(client, { orgId: ORG_ID, projectId: FORGED_PROJECT, contract }, { kind: "operator" }),
    );
    // Override the contract's jsonb to declare a target OUTSIDE the frozen adapter
    // union. The composer MUST reject it loudly — never silently compose web-only.
    // Simulate a full-V2 capture by ALSO updating `version` to 2 (the V2 schema
    // requires version=2; a V1+targetProfiles blob is neither valid V1 nor V2).
    await runWithOrgScope(runtimePool, ORG_ID, (client) =>
      client.query(
        `UPDATE design_contracts
            SET contract = jsonb_set(contract, '{targetProfiles}', $1::jsonb)
          WHERE org_id = $2 AND project_id = $3`,
        [JSON.stringify([{ target: "totally-fake-target", capabilities: [], required: true }]), ORG_ID, FORGED_PROJECT],
      ),
    );
    await runWithOrgScope(runtimePool, ORG_ID, (client) =>
      client.query(
        `UPDATE design_contracts SET contract = jsonb_set(contract, '{version}', '2'::jsonb) WHERE org_id = $1 AND project_id = $2`,
        [ORG_ID, FORGED_PROJECT],
      ),
    );

    await expect(
      composeProjectTargetDesignSystems(
        {
          pool: runtimePool,
          artifactStore: new FilesystemArtifactStore(artifactRoot),
          fragmentAnswerer: fixtureFragmentAnswerer(),
          eventStore: new CapturingEventStore(),
          createdBy: "tanren.ds7-multi.test",
        },
        { orgId: ORG_ID, projectId: FORGED_PROJECT },
      ),
    ).rejects.toThrow(/frozen adapter union/u);

    // No release was published for the forged project.
    const resolved = await runWithOrgScope(runtimePool, ORG_ID, (client) =>
      resolveProjectWebDesignSystem(client, { orgId: ORG_ID, projectId: FORGED_PROJECT }),
    );
    expect(resolved).toBeUndefined();
  });
});
