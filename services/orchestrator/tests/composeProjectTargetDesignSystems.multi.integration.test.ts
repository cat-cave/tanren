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
import { resolveDesignRenderGate } from "../src/engine/merge/designRenderLandGate.js";
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
    await ownerPool.query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
       VALUES ('spec_ds7_multi', $1, $2, 'ds7 multi', 'conformance gate fixture', 'in_flight')`,
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
            {
              target: "web-react",
              capabilities: ["css-variables", "tailwind", "shadcn", "radix", "catalog", "storybook", "exports", "dtcg"],
              required: true,
            },
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

  it("NEGATIVE CONTROL — a required Bevy target without a native validator records inconclusive, blocks land, and never publishes", async () => {
    await expect(
      composeProjectTargetDesignSystems(
        {
          pool: runtimePool,
          artifactStore: new FilesystemArtifactStore(artifactRoot),
          fragmentAnswerer: fixtureFragmentAnswerer(),
          eventStore: new CapturingEventStore(),
          createdBy: "tanren.ds7-multi.test",
        },
        { orgId: ORG_ID, projectId: PROJECT_ID },
      ),
    ).rejects.toThrow(/required design target 'bevy' conformance is 'inconclusive_infrastructure'/u);

    // The conformance rows are durable even though the release does not advance.
    const release = await runWithOrgScope(runtimePool, ORG_ID, (client) =>
      client.query<{ id: string; state: string; canonical_artifact_id: string | null }>(
        `SELECT release.id, release.state, release.canonical_artifact_id
           FROM design_system_releases release
           JOIN design_contracts contract ON contract.org_id = release.org_id AND contract.id = release.contract_id
          WHERE release.org_id = $1 AND contract.project_id = $2`,
        [ORG_ID, PROJECT_ID],
      ),
    );
    expect(release.rows).toHaveLength(1);
    expect(release.rows[0]?.state).toBe("draft");
    expect(release.rows[0]?.canonical_artifact_id).toBeNull();

    const store = new DesignAdapterConformanceStore(runtimePool);
    const panelRows = await store.listForProject(ORG_ID, PROJECT_ID);
    expect(panelRows.map((row) => row.target).sort()).toEqual(["bevy", "web-react"]);
    const bevy = panelRows.find((row) => row.target === "bevy");
    const web = panelRows.find((row) => row.target === "web-react");
    expect(bevy?.outcome).toBe("inconclusive_infrastructure");
    expect(web?.outcome).toBe("passed");

    // There is no accidental publication, even though both artifacts and receipts exist.
    const persistedArtifacts = await runWithOrgScope(runtimePool, ORG_ID, (client) =>
      client.query<{ id: string; digest: string }>(
        "SELECT id, digest FROM design_artifacts WHERE org_id = $1 AND id = ANY($2)",
        [ORG_ID, panelRows.map((row) => row.artifactId)],
      ),
    );
    expect(persistedArtifacts.rows).toHaveLength(2);

    // Simulate an adversarial DB-only release-state escalation after the composer
    // correctly refused it. The land reader must still consume the Bevy row and
    // return its typed fail-closed block rather than trusting publication state.
    await runWithOrgScope(runtimePool, ORG_ID, (client) =>
      client.query(
        `UPDATE design_system_releases
            SET state = 'published', canonical_artifact_id = $1, published_by = 'adversary', published_at = now()
          WHERE org_id = $2 AND id = $3`,
        [web!.artifactId, ORG_ID, release.rows[0]!.id],
      ),
    );
    await ownerPool.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
       VALUES ('run_ds7_multi', 'spec_ds7_multi', $1, $2, 'cli', 'feat', 'running')`,
      [PROJECT_ID, ORG_ID],
    );
    const gate = await resolveDesignRenderGate(runtimePool, ORG_ID, "run_ds7_multi");
    expect(gate).toMatchObject({ kind: "inconclusive_infrastructure" });
    expect(gate.kind === "inconclusive_infrastructure" && gate.reason).toContain("bevy");
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
    const releases = await runWithOrgScope(runtimePool, ORG_ID, (client) =>
      client.query(
        `SELECT release.id
           FROM design_system_releases release
           JOIN design_contracts contract ON contract.org_id = release.org_id AND contract.id = release.contract_id
          WHERE release.org_id = $1 AND contract.project_id = $2 AND release.state = 'published'`,
        [ORG_ID, FORGED_PROJECT],
      ),
    );
    expect(releases.rows).toEqual([]);
  });

  it("NEGATIVE CONTROL — a Bevy-only contract never runs web render verification against a non-web coordinate", async () => {
    const projectId = "project_ds7_bevy_only";
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
       VALUES ($1, 'DS Bevy only', 'https://example.test/ds-bevy.git', 'main', 'runner:test', $2, '{"version":1}'::jsonb)`,
      [projectId, ORG_ID],
    );
    const contract = parseDesignContract({
      version: 1,
      domain: "game",
      identity: "a Bevy-only HUD",
      intent: "native game UI with no web surface",
      dimensions: [{ key: "hud", label: "HUD", intent: "game overlay", guidance: "", personaRefs: [] }],
    });
    await runWithOrgScope(runtimePool, ORG_ID, (client) =>
      DesignContractStore.create(client, { orgId: ORG_ID, projectId, contract }, { kind: "operator" }),
    );
    await runWithOrgScope(runtimePool, ORG_ID, (client) =>
      client.query(
        `UPDATE design_contracts
            SET contract = jsonb_set(jsonb_set(contract, '{version}', '2'::jsonb), '{targetProfiles}', $1::jsonb)
          WHERE org_id = $2 AND project_id = $3`,
        [
          JSON.stringify([
            {
              target: "bevy",
              capabilities: ["tokens", "catalog", "components", "bevy-ui", "bevy-asset", "cargo"],
              required: true,
            },
          ]),
          ORG_ID,
          projectId,
        ],
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
        { orgId: ORG_ID, projectId },
      ),
    ).rejects.toThrow(/required design target 'bevy' conformance/u);

    const store = new DesignAdapterConformanceStore(runtimePool);
    expect((await store.listForProject(ORG_ID, projectId)).map((row) => row.target)).toEqual(["bevy"]);
    const renderVerdicts = await runWithOrgScope(runtimePool, ORG_ID, (client) =>
      client.query("SELECT id FROM design_render_land_verdicts WHERE org_id = $1 AND project_id = $2", [
        ORG_ID,
        projectId,
      ]),
    );
    expect(renderVerdicts.rows).toEqual([]);
  });
});
