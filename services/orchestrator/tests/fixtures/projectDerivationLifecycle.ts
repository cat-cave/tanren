import { runWithOrgScope } from "@tanren/db";
import type { Pool } from "pg";
import { InterviewCapture } from "../../src/engine/forge/interview/types.js";
import { buildDerivationOwnership, repositoryOwnershipMarker } from "../../src/engine/repositories/projects.js";
import type { SeededTemplate } from "../../src/engine/templates/index.js";

export const SEED: SeededTemplate = {
  templateRef: "tanren://composed/proof@1234567890ab",
  validatedAt: "2026-07-16T00:00:00.000Z",
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
