// mq-12 read-only evidence-contract projection. It exposes the durable proof-unit
// observation for one integration node; it never runs, edits, or renders a command.

import { runWithOrgScope } from "@tanren/db";
import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { FragmentContractSchema } from "../../engine/templates/fragments/fragmentEvidenceContract.js";
import { assertProjectAccess, ToolAccessDeniedError } from "../../engine/forge/tools/authz.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";

const EVIDENCE_PREFIX = "fragment_evidence:";

const EvidenceUnitRow = z
  .object({
    proof_unit_id: z.string().min(1),
    subject_id: z.string().min(1),
    input_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    artifact_hash: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/u)
      .nullable(),
    verdict: z.enum(["pass", "fail", "skipped"]),
  })
  .strict();

interface EvidenceContractRoutesOptions {
  pool: pg.Pool;
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) throw new Error("actor missing on context");
  return c.var.actor;
}

function fallbackReason(subjectId: string): string | null {
  const prefix = `${EVIDENCE_PREFIX}fallback:`;
  return subjectId.startsWith(prefix) ? subjectId.slice(prefix.length) : null;
}

/** GET one node's redacted declarative contract + durable selection observation. */
export function createMergeQueueEvidenceContractRoutes(options: EvidenceContractRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  app.get("/:orgId/projects/:projectId/merge-queue/evidence-contracts/:nodeId", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) return c.json({ error: "merge_queue_evidence_contract_not_found" }, 404);
    const projectId = c.req.param("projectId");
    const nodeId = c.req.param("nodeId");
    const result = await runWithOrgScope(options.pool, orgId, async (client) => {
      try {
        const project = await assertProjectAccess(client, projectId, actor);
        if (project.orgId !== orgId) return null;
      } catch (error) {
        if (error instanceof ToolAccessDeniedError) return null;
        throw error;
      }
      const unitResult = await client.query<Record<string, unknown>>(
        `SELECT proof_unit_id, subject_id, input_hash, artifact_hash, verdict
           FROM integration_proof_units
          WHERE org_id = $1 AND project_id = $2 AND source_node_id = $3
            AND kind = 'artifact_provenance' AND subject_id LIKE 'fragment_evidence:%'
          ORDER BY created_at DESC, proof_unit_id DESC
          LIMIT 1`,
        [orgId, projectId, nodeId],
      );
      const unit = EvidenceUnitRow.safeParse(unitResult.rows[0]);
      if (!unit.success)
        return { resolutionStatus: "unavailable" as const, contract: null, proofUnit: null, fallback: "unobserved" };
      const selected = unit.data.subject_id === "fragment_evidence:selected" && unit.data.verdict === "pass";
      const contract =
        selected && unit.data.artifact_hash !== null
          ? await findUniqueFrozenContract(client, orgId, unit.data.artifact_hash)
          : null;
      return {
        resolutionStatus: selected
          ? contract === null
            ? "selected_contract_unavailable"
            : "selected"
          : "full_gate_fallback",
        contract,
        proofUnit: {
          id: unit.data.proof_unit_id,
          inputHash: unit.data.input_hash,
          artifactDigest: unit.data.artifact_hash,
          verdict: unit.data.verdict,
        },
        fallback: selected ? null : (fallbackReason(unit.data.subject_id) ?? "unobserved"),
      };
    });
    if (result === null) return c.json({ error: "merge_queue_evidence_contract_not_found" }, 404);
    return c.json(result);
  });
  return app;
}

async function findUniqueFrozenContract(client: pg.PoolClient, orgId: string, digest: string) {
  const result = await client.query<Record<string, unknown>>(
    `SELECT contract
       FROM fragments
      WHERE org_id = $1 AND status = 'validated'
        AND contract->'evidence'->>'contentDigest' = $2
      ORDER BY validated_at DESC NULLS LAST, fragment_id DESC
      LIMIT 2`,
    [orgId, digest],
  );
  if (result.rowCount !== 1) return null;
  const contract = FragmentContractSchema.safeParse(result.rows[0]?.["contract"]);
  if (!contract.success || contract.data.evidence === undefined) return null;
  // Every field is declarative repository metadata + an immutable digest. Return
  // no body_ts, writer prompt, credentials, or executable text.
  return contract.data.evidence;
}
