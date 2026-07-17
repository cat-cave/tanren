import { z } from "zod";

/** The only policy document language understood by gv-7. It is data, not prose. */
export const GovernanceApiVersion = z.literal("tanren.dev/governance/v2");

const PrincipalSchema = z
  .object({
    kind: z.enum(["agent_profile", "user", "team"]),
    name: z.string().min(1).max(256),
  })
  .strict();

const RuleSchemas = [
  z.object({ key: z.literal("repository.visibility"), value: z.enum(["public", "private"]) }).strict(),
  z.object({ key: z.literal("review.mode"), value: z.enum(["auto", "simulated", "human"]) }).strict(),
  z.object({ key: z.literal("review.minimum_approvals"), value: z.number().int().nonnegative() }).strict(),
  z.object({ key: z.literal("review.freshness"), value: z.enum(["none", "branch_head", "exact_head_sha"]) }).strict(),
  z.object({ key: z.literal("review.require_forge_publication"), value: z.boolean() }).strict(),
  z.object({ key: z.literal("review.dismiss_on_base_shift"), value: z.boolean() }).strict(),
  z
    .object({
      key: z.literal("review.required_principal"),
      value: PrincipalSchema,
    })
    .strict(),
  z.object({ key: z.literal("audit.block_at"), value: z.enum(["P0", "P1", "P2", "P3"]) }).strict(),
  z
    .object({
      key: z.literal("audit.residual_disposition"),
      value: z.enum(["new_spec", "human_required", "risk_accepted"]),
    })
    .strict(),
  z
    .object({
      key: z.literal("integration.max_unmerged_ancestor_depth"),
      value: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ key: z.literal("integration.require_base_shift_regate"), value: z.boolean() }).strict(),
  z.object({ key: z.literal("budget.monthly_usd"), value: z.number().finite().positive() }).strict(),
  z.object({ key: z.literal("budget.per_spec_usd"), value: z.number().finite().positive() }).strict(),
  z.object({ key: z.literal("budget.unknown_cost_action"), value: z.enum(["allow", "warn", "pause"]) }).strict(),
  z.object({ key: z.literal("notifications.quorum"), value: z.number().int().nonnegative() }).strict(),
  z.object({ key: z.literal("coverage.max_evidence_age_days"), value: z.number().int().nonnegative() }).strict(),
] as const;

/** A closed rule vocabulary keeps compilation finite and testable. */
export const PolicyRuleSchema = z.discriminatedUnion("key", RuleSchemas);
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export const PolicyLayerSchema = z
  .object({
    rules: z.array(PolicyRuleSchema),
  })
  .strict();

/**
 * A policy is composed in this fixed order. A layer may tighten an earlier
 * layer; it cannot execute code, contain natural-language instructions, or
 * introduce an unknown primitive.
 */
export const PolicyAstSchema = z
  .object({
    apiVersion: GovernanceApiVersion,
    schemaVersion: z.number().int().positive(),
    core: PolicyLayerSchema,
    org: PolicyLayerSchema,
    tier: PolicyLayerSchema,
    binding: PolicyLayerSchema,
  })
  .strict();

export type PolicyAst = z.infer<typeof PolicyAstSchema>;

export const POLICY_LAYER_ORDER = ["core", "org", "tier", "binding"] as const;
export type PolicyLayerName = (typeof POLICY_LAYER_ORDER)[number];

export function parsePolicyAst(input: unknown): PolicyAst {
  return PolicyAstSchema.parse(input);
}
