// gv-3 — callable receipt of the project's REAL policy identity (content hash of
// governance-sensitive fields). Operators and the dashboard assert the same digest
// MergeAuthority stamps on land bindings — never the schema literal `version: 1`.

import type { Context } from "hono";
import type pg from "pg";
import { z } from "zod";
import { POLICY_IDENTITY_FIELDS, resolveProjectPolicyIdentity } from "../../engine/governance/policyGateIdentity.js";
import { ProjectStore } from "../../engine/repositories/index.js";
import { systemActor } from "../../engine/state/actor.js";

/** Runtime-validated response shape for GET policy-identity. */
export const PolicyIdentityViewSchema = z
  .object({
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    /** Non-empty hex digest — the sole land/proof policy identity. */
    policyHash: z.string().regex(/^[0-9a-f]{64}$/u),
    /** Fields folded into the digest (stable, documented). */
    fields: z.array(z.enum(POLICY_IDENTITY_FIELDS)).min(1),
    /** Explicit: schema version is NOT the policy identity. */
    schemaVersion: z.literal(1),
    /** Apex-ready named proof id for live assertions. */
    proof: z.literal("gv3_policy_identity_receipt"),
  })
  .strict();

export type PolicyIdentityView = z.infer<typeof PolicyIdentityViewSchema>;

/**
 * GET handler: resolve the project's governance policy content hash under org scope.
 * 404 when the project is missing or not owned by the path org (no metadata leak).
 */
export async function handlePolicyIdentityGet(
  c: Context,
  pool: pg.Pool,
  orgId: string,
  projectId: string,
): Promise<Response> {
  const ownership = await ProjectStore.getOwnership(pool, projectId, systemActor);
  if (ownership === undefined || ownership.orgId === null || ownership.orgId !== orgId) {
    return c.json({ error: "project_not_found" }, 404);
  }
  const config = await ProjectStore.getConfig(pool, projectId, systemActor);
  if (config === undefined) {
    return c.json({ error: "project_not_found" }, 404);
  }
  let policyHash: string;
  try {
    policyHash = resolveProjectPolicyIdentity(config).policyHash;
  } catch {
    return c.json({ error: "project_config_unreadable" }, 422);
  }
  const view: PolicyIdentityView = {
    orgId,
    projectId,
    policyHash,
    fields: [...POLICY_IDENTITY_FIELDS],
    schemaVersion: 1,
    proof: "gv3_policy_identity_receipt",
  };
  // Fail closed on accidental shape drift before the response leaves the process.
  const parsed = PolicyIdentityViewSchema.safeParse(view);
  if (!parsed.success) {
    return c.json({ error: "policy_identity_invalid", issues: parsed.error.issues }, 500);
  }
  return c.json(parsed.data);
}
