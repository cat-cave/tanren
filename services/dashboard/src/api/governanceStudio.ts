/**
 * Strict dashboard contracts for the gv-7..14 governance Studio read and
 * command surfaces. The Studio is only a typed HTTP consumer: policy truth
 * stays with the orchestrator's org-scoped governance routes.
 */

import { z } from "zod";

const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const IdentifierSchema = z.string().trim().min(1).max(256);
const TimestampSchema = z.string().min(1);

const PrincipalSchema = z.object({ kind: z.enum(["agent_profile", "user", "team"]), name: IdentifierSchema }).strict();
const PolicyRuleSchema = z.discriminatedUnion("key", [
  z.object({ key: z.literal("repository.visibility"), value: z.enum(["public", "private"]) }).strict(),
  z.object({ key: z.literal("review.mode"), value: z.enum(["auto", "simulated", "human"]) }).strict(),
  z.object({ key: z.literal("review.minimum_approvals"), value: z.number().int().nonnegative() }).strict(),
  z.object({ key: z.literal("review.freshness"), value: z.enum(["none", "branch_head", "exact_head_sha"]) }).strict(),
  z.object({ key: z.literal("review.require_forge_publication"), value: z.boolean() }).strict(),
  z.object({ key: z.literal("review.dismiss_on_base_shift"), value: z.boolean() }).strict(),
  z.object({ key: z.literal("review.required_principal"), value: PrincipalSchema }).strict(),
  z.object({ key: z.literal("audit.block_at"), value: z.enum(["P0", "P1", "P2", "P3"]) }).strict(),
  z
    .object({
      key: z.literal("audit.residual_disposition"),
      value: z.enum(["new_spec", "human_required", "risk_accepted"]),
    })
    .strict(),
  z
    .object({ key: z.literal("integration.max_unmerged_ancestor_depth"), value: z.number().int().nonnegative() })
    .strict(),
  z.object({ key: z.literal("integration.require_base_shift_regate"), value: z.boolean() }).strict(),
  z.object({ key: z.literal("budget.monthly_usd"), value: z.number().finite().positive() }).strict(),
  z.object({ key: z.literal("budget.per_spec_usd"), value: z.number().finite().positive() }).strict(),
  z.object({ key: z.literal("budget.unknown_cost_action"), value: z.enum(["allow", "warn", "pause"]) }).strict(),
  z.object({ key: z.literal("notifications.quorum"), value: z.number().int().nonnegative() }).strict(),
  z.object({ key: z.literal("coverage.max_evidence_age_days"), value: z.number().int().nonnegative() }).strict(),
]);
const PolicyLayerSchema = z.object({ rules: z.array(PolicyRuleSchema) }).strict();
const PolicyLayersSchema = z
  .object({ core: PolicyLayerSchema, org: PolicyLayerSchema, tier: PolicyLayerSchema, binding: PolicyLayerSchema })
  .strict();
const FragmentIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,127}$/u);
const FragmentSpecSchema = z
  .object({
    fragmentId: FragmentIdSchema,
    version: z.string().regex(/^\d+\.\d+\.\d+$/u),
    dependsOn: z.array(FragmentIdSchema).max(32),
    derivation: z
      .object({
        personaRevisionIds: z.array(IdentifierSchema).max(128),
        behaviorRevisionIds: z.array(IdentifierSchema).max(128),
        designEntityIds: z.array(IdentifierSchema).max(128),
        riskClassifications: z.array(z.string().min(1).max(128)).min(1).max(32),
      })
      .strict(),
    requiredPolicy: PolicyLayersSchema,
  })
  .strict()
  .superRefine((fragment, context) => {
    if (new Set(fragment.dependsOn).size !== fragment.dependsOn.length) {
      context.addIssue({ code: "custom", message: "fragment dependencies must be unique" });
    }
    if (fragment.dependsOn.includes(fragment.fragmentId)) {
      context.addIssue({ code: "custom", message: "fragment cannot depend on itself" });
    }
  });

/** Gate raw Studio author input before it reaches the remote authority. */
export const GovernanceFragmentConfigSchema = z
  .object({
    apiVersion: z.literal("tanren.dev/governance-fragments/v1"),
    schemaVersion: z.literal(1),
    fragments: z.array(FragmentSpecSchema).min(1).max(64),
  })
  .strict()
  .superRefine((config, context) => {
    const ids = config.fragments.map((fragment) => fragment.fragmentId);
    if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "fragment ids must be unique" });
    if (ids.includes("base")) context.addIssue({ code: "custom", message: "base is supplied by the kernel" });
  });

export const PolicyRevisionSchema = z
  .object({
    id: IdentifierSchema,
    projectId: IdentifierSchema,
    revisionNumber: z.number().int().positive(),
    schemaVersion: z.number().int().positive(),
    sourceDocument: z.unknown(),
    compiledAst: z.unknown(),
    policyHash: DigestSchema,
    parentRevisionId: IdentifierSchema.optional(),
    createdBy: IdentifierSchema,
    createdAt: TimestampSchema,
  })
  .strict();
export type PolicyRevision = z.infer<typeof PolicyRevisionSchema>;

export const GovernanceTierSchema = z
  .object({
    id: IdentifierSchema,
    projectId: IdentifierSchema,
    tierName: IdentifierSchema,
    preset: z.enum(["open", "standard", "private", "regulated"]),
    tierJson: z.unknown(),
    canonicalHash: DigestSchema,
    state: IdentifierSchema,
    createdAt: TimestampSchema,
  })
  .strict();
export type GovernanceTier = z.infer<typeof GovernanceTierSchema>;

export const PolicyBindingSchema = z
  .object({
    id: IdentifierSchema,
    projectId: IdentifierSchema,
    tierId: IdentifierSchema,
    effectivePolicyHash: DigestSchema,
    isActive: z.boolean(),
    createdAt: TimestampSchema,
  })
  .strict();
export type PolicyBinding = z.infer<typeof PolicyBindingSchema>;

export const EffectivePolicySubjectKindSchema = z.enum(["run", "change", "activation"]);
export type EffectivePolicySubjectKind = z.infer<typeof EffectivePolicySubjectKindSchema>;

export const EffectivePolicySnapshotSchema = z
  .object({
    id: IdentifierSchema,
    projectId: IdentifierSchema,
    bindingId: IdentifierSchema,
    tierId: IdentifierSchema,
    policyRevisionId: IdentifierSchema,
    effectivePolicyHash: DigestSchema,
    compiledBody: z.unknown(),
    subjectKind: EffectivePolicySubjectKindSchema,
    subjectId: IdentifierSchema,
    inputsDigest: DigestSchema,
    createdAt: TimestampSchema,
    createdBy: IdentifierSchema,
  })
  .strict();
export type EffectivePolicySnapshot = z.infer<typeof EffectivePolicySnapshotSchema>;

export const GovernanceRevisionsResponseSchema = z.object({ revisions: z.array(PolicyRevisionSchema) }).strict();
export const GovernanceTiersResponseSchema = z.object({ tiers: z.array(GovernanceTierSchema) }).strict();
export const GovernanceBindingsResponseSchema = z.object({ bindings: z.array(PolicyBindingSchema) }).strict();
export const EffectivePolicyResponseSchema = z.object({ snapshot: EffectivePolicySnapshotSchema }).strict();

export const CreatePolicyRevisionResponseSchema = z
  .object({
    revision: PolicyRevisionSchema,
    fragmentSnapshot: z.array(
      z.object({ fragmentId: IdentifierSchema, version: z.string().min(1), fragmentDigest: DigestSchema }).strict(),
    ),
    fragmentSnapshotDiff: z
      .object({ added: z.array(z.string()), removed: z.array(z.string()), changed: z.array(z.string()) })
      .strict(),
  })
  .strict();
export const ActivatePolicyRevisionResponseSchema = z.object({ revision: PolicyRevisionSchema }).strict();
export const BindGovernanceTierResponseSchema = z
  .object({ tier: GovernanceTierSchema, binding: PolicyBindingSchema, policyRevisionId: IdentifierSchema })
  .strict();

export interface GovernanceStudioData {
  readonly revisions: readonly PolicyRevision[];
  readonly tiers: readonly GovernanceTier[];
  readonly bindings: readonly PolicyBinding[];
  readonly activeBinding: PolicyBinding | undefined;
  readonly tiersById: ReadonlyMap<string, GovernanceTier>;
}

/**
 * Confirm the exact read model before rendering any policy assertion. A bad
 * response is not an empty Studio: callers render its reason as unavailable.
 */
export function governanceStudioData(
  projectId: string,
  revisions: readonly PolicyRevision[],
  tiers: readonly GovernanceTier[],
  bindings: readonly PolicyBinding[],
): GovernanceStudioData | undefined {
  if (
    revisions.some((revision) => revision.projectId !== projectId) ||
    tiers.some((tier) => tier.projectId !== projectId) ||
    bindings.some((binding) => binding.projectId !== projectId)
  ) {
    return undefined;
  }
  if (!strictlyAscendingRevisions(revisions) || !uniqueBy(revisions, (revision) => revision.id)) return undefined;
  if (!uniqueBy(tiers, (tier) => tier.id) || !uniqueBy(bindings, (binding) => binding.id)) return undefined;

  const revisionsById = new Map(revisions.map((revision) => [revision.id, revision]));
  if (
    revisions.some((revision) => {
      if (revision.parentRevisionId === undefined) return false;
      const parent = revisionsById.get(revision.parentRevisionId);
      return parent === undefined || parent.revisionNumber >= revision.revisionNumber;
    })
  ) {
    return undefined;
  }

  const tiersById = new Map(tiers.map((tier) => [tier.id, tier]));
  if (
    bindings.some((binding) => {
      const tier = tiersById.get(binding.tierId);
      return tier === undefined || tier.canonicalHash !== binding.effectivePolicyHash;
    })
  ) {
    return undefined;
  }
  const active = bindings.filter((binding) => binding.isActive);
  if (active.length > 1) return undefined;

  return { revisions, tiers, bindings, activeBinding: active[0], tiersById };
}

function strictlyAscendingRevisions(revisions: readonly PolicyRevision[]): boolean {
  for (let index = 1; index < revisions.length; index += 1) {
    const previous = revisions[index - 1];
    const current = revisions[index];
    if (previous === undefined || current === undefined || previous.revisionNumber >= current.revisionNumber)
      return false;
  }
  return true;
}

function uniqueBy<T>(entries: readonly T[], key: (entry: T) => string): boolean {
  return new Set(entries.map((entry) => key(entry))).size === entries.length;
}
