// gv-14 — governance config import facade.
//
// A single operation ingests a governance config bundle and applies it
// ATOMICALLY on top of the existing gv-7/8/9 stores. Fail-closed in two layers:
//
//   1. PRE-FLIGHT (pure, no DB): every arbitrary policy document in the bundle
//      is run through the gv-13 `validatePolicy` analysis. A malformed or
//      contradictory document rejects the WHOLE bundle before any transaction
//      is opened — no partial state can exist.
//   2. COMMIT (one transaction on one client): the tiers, policy revisions and
//      the optional active-tier binding are created via the existing stores.
//      Any failure mid-commit (a re-validating store rejection, an unknown or
//      ambiguous activate-tier reference) throws, and the caller's
//      `runWithOrgScope` transaction rolls the whole import back.
//
// The import invents no new event vocabulary: it emits only the per-op events
// the composed stores already append (governance.tier.created /
// governance.policy.created / governance.binding.activated), so its provenance
// is the frozen event trail and it needs no migration.

import { z } from "zod";
import type { ContradictionWitness } from "./contradictionWitness.js";
import type { QueryClient } from "../data/orgScopedDb.js";
import { validatePolicy, type ContradictionWitnessProof, type PrincipalReference } from "./policyAnalysis.js";
import { createPolicyRevision, type PolicyRevision } from "./policyRevisionStore.js";
import {
  bindGovernanceTier,
  createGovernanceTier,
  getGovernanceTierByName,
  type GovernanceTier,
  type PolicyBinding,
} from "./governanceTierStore.js";
import { GovernanceTierPresetSchema } from "./tierPresets.js";

export const GOVERNANCE_IMPORT_API_VERSION = "tanren.dev/governance/import/v1";

const ImportTierSchema = z
  .object({
    tierName: z.string().min(1).max(256),
    preset: GovernanceTierPresetSchema,
  })
  .strict();

const ImportPolicySchema = z
  .object({
    sourceDocument: z.unknown(),
  })
  .strict();

/** The whole governance config bundle a single import applies atomically. */
export const GovernanceImportBundleSchema = z
  .object({
    apiVersion: z.literal(GOVERNANCE_IMPORT_API_VERSION),
    tiers: z.array(ImportTierSchema).max(64).optional().default([]),
    policies: z.array(ImportPolicySchema).max(64).optional().default([]),
    activateTierName: z.string().min(1).max(256).optional(),
  })
  .strict();

export type GovernanceImportBundle = z.infer<typeof GovernanceImportBundleSchema>;

/** A whole-bundle rejection produced by the pure pre-flight, before any write. */
export type GovernanceImportRejection =
  | { readonly kind: "malformed_policy"; readonly index: number; readonly issues: readonly z.core.$ZodIssue[] }
  | {
      readonly kind: "contradictory_policy";
      readonly index: number;
      readonly contradictionWitnesses: readonly ContradictionWitness[];
      readonly witnessProofs: readonly ContradictionWitnessProof[];
      readonly unresolvedReferences: readonly PrincipalReference[];
    };

export type GovernanceImportPreflight =
  | { readonly ok: true; readonly bundle: GovernanceImportBundle }
  | { readonly ok: false; readonly rejection: GovernanceImportRejection };

export interface GovernanceImportReceipt {
  readonly tiers: readonly GovernanceTier[];
  readonly revisions: readonly PolicyRevision[];
  readonly activation:
    | { readonly tier: GovernanceTier; readonly binding: PolicyBinding; readonly policyRevisionId: string }
    | undefined;
}

/**
 * Pure, DB-free pre-flight. Validates every arbitrary policy document in the
 * bundle through the gv-13 analysis and rejects the WHOLE bundle on the first
 * malformed or contradictory document. Tier presets are already constrained by
 * the schema, so only the free-form `policies[]` need semantic analysis.
 */
export function preflightGovernanceImport(bundle: GovernanceImportBundle): GovernanceImportPreflight {
  for (let index = 0; index < bundle.policies.length; index += 1) {
    const report = validatePolicy(bundle.policies[index]?.sourceDocument);
    if (report.status === "malformed") {
      return { ok: false, rejection: { kind: "malformed_policy", index, issues: report.issues } };
    }
    if (report.status === "contradictory") {
      return {
        ok: false,
        rejection: {
          kind: "contradictory_policy",
          index,
          contradictionWitnesses: report.contradictionWitnesses,
          witnessProofs: report.witnessProofs,
          unresolvedReferences: report.unresolvedReferences,
        },
      };
    }
  }
  return { ok: true, bundle };
}

export interface CommitGovernanceImportContext {
  readonly orgId: string;
  readonly projectId: string;
  readonly createdBy: string;
}

/**
 * Apply a pre-flighted bundle on a single client. MUST run inside one
 * `runWithOrgScope` transaction so any throw rolls the entire import back — no
 * tier, revision or binding is left behind. The activate-tier reference is
 * resolved against every tier in the project (including tiers created earlier
 * in this same transaction); an unknown or ambiguous name throws, rolling back.
 */
export async function commitGovernanceImport(
  client: QueryClient,
  context: CommitGovernanceImportContext,
  bundle: GovernanceImportBundle,
): Promise<GovernanceImportReceipt> {
  const tiers: GovernanceTier[] = [];
  for (const tier of bundle.tiers) {
    tiers.push(
      await createGovernanceTier(client, {
        orgId: context.orgId,
        projectId: context.projectId,
        tierName: tier.tierName,
        preset: tier.preset,
      }),
    );
  }

  const revisions: PolicyRevision[] = [];
  for (const policy of bundle.policies) {
    revisions.push(
      await createPolicyRevision(client, {
        orgId: context.orgId,
        projectId: context.projectId,
        sourceDocument: policy.sourceDocument,
        createdBy: context.createdBy,
      }),
    );
  }

  let activation: GovernanceImportReceipt["activation"];
  if (bundle.activateTierName !== undefined) {
    const tier = await getGovernanceTierByName(client, context.orgId, context.projectId, bundle.activateTierName);
    activation = await bindGovernanceTier(client, {
      orgId: context.orgId,
      projectId: context.projectId,
      tierId: tier.id,
      createdBy: context.createdBy,
    });
  }

  return { tiers, revisions, activation };
}
