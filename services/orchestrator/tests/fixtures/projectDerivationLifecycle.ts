import { runWithOrgScope } from "@tanren/db";
import type { Pool } from "pg";
import type { ActorContext } from "../../src/auth/schemas.js";
import { InterviewCapture } from "../../src/engine/forge/interview/types.js";
import { buildDerivationDesignPlan } from "../../src/engine/forge/interview/deriveDesignContract.js";
import { IntegrationConnectionsStore } from "../../src/engine/repositories/integrationConnections.js";
import { buildDerivationOwnership, repositoryOwnershipMarker } from "../../src/engine/repositories/projects.js";
import { systemActor } from "../../src/engine/state/actor.js";
import type { SeededTemplate } from "../../src/engine/templates/index.js";
import {
  provisionAutonomousProject,
  type ProvisionAutonomousProjectResult,
} from "../../src/engine/workflow/provisionAutonomousProject.js";

export const SEED: SeededTemplate = {
  templateRef: "tanren://composed/proof@1234567890ab",
  validatedAt: "2026-07-16T00:00:00.000Z",
};

export const DERIVATION_ACTOR: ActorContext = {
  userId: "derivation-test",
  orgId: "org_derivation_a",
  projectId: null,
  scopes: ["platform:admin"],
  source: "local_dev",
};

/* eslint-disable unicorn/no-thenable -- Given/When/Then is the persisted behavior vocabulary. */
export const GRAPH_CAPTURE = InterviewCapture.parse({
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

export const graphDesignPlan = (fingerprint: string) => buildDerivationDesignPlan(GRAPH_CAPTURE, fingerprint);

export function directSanitizedInput(): Record<string, unknown> {
  return { kind: "direct_greenfield", input: { deploy: { providerKind: "deploy.vercel" } } };
}

export function ownership(orgId: string, projectId: string, repoUrl: string, fingerprint: string) {
  return buildDerivationOwnership({
    kind: "managed",
    orgId,
    projectId,
    repoUrl,
    idempotencyFingerprint: fingerprint,
    ownershipMarker: repositoryOwnershipMarker(fingerprint),
    fullName: new URL(repoUrl).pathname.slice(1).replace(/\.git$/u, ""),
    requestedDefaultBranch: "main",
  });
}

export function repository(repoUrl: string) {
  return {
    fullName: new URL(repoUrl).pathname.slice(1).replace(/\.git$/u, ""),
    repoUrl,
    defaultBranch: "main",
  };
}

export async function corruptReceipt(pool: Pool, projectId: string, path: string, value: string): Promise<void> {
  await pool.query(
    "UPDATE project_derivations SET result_receipt = jsonb_set(result_receipt, $2::text[], to_jsonb($3::text)) WHERE project_id = $1",
    [projectId, path.slice(1, -1).split(","), value],
  );
}

export async function setReceiptValue(pool: Pool, projectId: string, path: string, value: unknown): Promise<void> {
  await pool.query(
    "UPDATE project_derivations SET result_receipt = jsonb_set(result_receipt, $2::text[], $3::jsonb) WHERE project_id = $1",
    [projectId, path.slice(1, -1).split(","), JSON.stringify(value)],
  );
}

export async function activationTuple(
  pool: Pool,
  orgId: string,
  projectId: string,
): Promise<{ lifecycle: string; status: string }> {
  return runWithOrgScope(pool, orgId, async (client) => {
    const result = await client.query<{ lifecycle: string; status: string }>(
      `SELECT p.lifecycle, d.status
         FROM projects p
         JOIN project_derivations d ON d.project_id = p.project_id AND d.org_id = p.org_id
        WHERE p.org_id = $1 AND p.project_id = $2`,
      [orgId, projectId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("activation tuple missing");
    return row;
  });
}

export async function graphCounts(pool: Pool, projectId: string): Promise<Record<string, number>> {
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

export async function seedActivationPrerequisites(
  pool: Pool,
  orgId: string,
  projects: Array<{ projectId: string; repoUrl: string }>,
): Promise<Map<string, ProvisionAutonomousProjectResult>> {
  await runWithOrgScope(pool, orgId, async (client) => {
    await client.query(
      `INSERT INTO org_integration_connections
         (org_id, id, provider_kind, provider_principal_id, principal_kind, display_name,
          principal_metadata, health, status, current_auth_generation, owner_id)
       VALUES ($1, 'connection_1', 'deploy.vercel', 'account_1', 'organization', 'account_1',
               '{}'::jsonb, 'healthy', 'active', 1, 'derivation-test')`,
      [orgId],
    );
    await client.query(
      `INSERT INTO org_integration_connection_auth_generations
         (org_id, provider_kind, connection_id, generation, credential_ref, auth_kind, status)
       VALUES ($1, 'deploy.vercel', 'connection_1', 1,
               'secret://fixture/deploy.vercel/connection_1/token/g/1', 'api_key', 'active')`,
      [orgId],
    );
    await client.query(
      `INSERT INTO org_integration_grants
         (org_id, id, provider_kind, connection_id, plane, environment, current_generation, status)
       VALUES ($1, 'grant_1', 'deploy.vercel', 'connection_1', 'control', 'control', 1, 'active')`,
      [orgId],
    );
    await client.query(
      `INSERT INTO org_integration_grant_generations
         (org_id, provider_kind, connection_id, grant_id, generation, capabilities, operations,
          provider_scopes, resource_constraints, policy_revision, consent_revision,
          consent_actor_id, consented_at, status)
       VALUES ($1, 'deploy.vercel', 'connection_1', 'grant_1', 1, ARRAY['deploy'],
               ARRAY['discover','provision','bind','teardown'], ARRAY[]::text[], '{}'::jsonb,
               'integration-catalog.v1', 'consent.test', 'derivation-test', now(), 'active')`,
      [orgId],
    );
  });

  for (const project of projects) {
    await runWithOrgScope(pool, orgId, (client) =>
      IntegrationConnectionsStore.selectControlGrant(
        client,
        {
          orgId,
          projectId: project.projectId,
          providerKind: "deploy.vercel",
          connectionId: "connection_1",
          grantId: "grant_1",
          authGeneration: 1,
          grantGeneration: 1,
        },
        systemActor,
      ),
    );
  }

  const bootstraps = new Map<string, ProvisionAutonomousProjectResult>();
  for (const project of projects) {
    const result = await provisionAutonomousProject({
      pool,
      orgId,
      projectId: project.projectId,
      repoUrl: project.repoUrl,
    });
    if (
      result.errors.length > 0 ||
      result.inboxSource === undefined ||
      result.notificationRoute === undefined ||
      result.auditCatalog === undefined
    ) {
      throw new Error(`activation prerequisite failed for ${project.projectId}`);
    }
    bootstraps.set(project.projectId, result);
  }
  return bootstraps;
}
