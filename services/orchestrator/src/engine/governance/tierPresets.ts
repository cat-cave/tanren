import { z } from "zod";
import type { PolicyAst } from "./policyAst.js";

export const GovernanceTierPresetSchema = z.enum(["open", "standard", "private", "regulated"]);
export type GovernanceTierPreset = z.infer<typeof GovernanceTierPresetSchema>;

export const GOVERNANCE_TIER_PRESET_NAMES = GovernanceTierPresetSchema.options;

export interface GovernanceTierPresetDefinition {
  readonly sourceDocument: PolicyAst;
}

function presetPolicy(repoVisibility: "public" | "private", rules: PolicyAst["tier"]["rules"]): PolicyAst {
  return {
    apiVersion: "tanren.dev/governance/v2",
    schemaVersion: 1,
    core: { rules: [] },
    org: { rules: [] },
    tier: { rules: [{ key: "repository.visibility", value: repoVisibility }, ...rules] },
    binding: { rules: [] },
  };
}

/**
 * The complete, typed tier vocabulary. These documents deliberately enter the
 * same gv-7 compiler as every other policy; they are not a parallel evaluator.
 */
export const GOVERNANCE_TIER_PRESETS: Readonly<Record<GovernanceTierPreset, GovernanceTierPresetDefinition>> = {
  open: {
    sourceDocument: presetPolicy("public", [
      { key: "review.mode", value: "auto" },
      { key: "review.minimum_approvals", value: 0 },
      { key: "review.freshness", value: "none" },
      { key: "review.require_forge_publication", value: false },
      { key: "review.dismiss_on_base_shift", value: false },
      { key: "audit.block_at", value: "P0" },
      { key: "audit.residual_disposition", value: "risk_accepted" },
      { key: "integration.max_unmerged_ancestor_depth", value: 4 },
      { key: "integration.require_base_shift_regate", value: false },
      { key: "budget.monthly_usd", value: 2000 },
      { key: "budget.per_spec_usd", value: 200 },
      { key: "budget.unknown_cost_action", value: "allow" },
      { key: "notifications.quorum", value: 0 },
      { key: "coverage.max_evidence_age_days", value: 90 },
    ]),
  },
  standard: {
    sourceDocument: presetPolicy("public", [
      { key: "review.mode", value: "simulated" },
      { key: "review.minimum_approvals", value: 1 },
      { key: "review.freshness", value: "branch_head" },
      { key: "review.require_forge_publication", value: true },
      { key: "review.dismiss_on_base_shift", value: true },
      { key: "audit.block_at", value: "P1" },
      { key: "audit.residual_disposition", value: "new_spec" },
      { key: "integration.max_unmerged_ancestor_depth", value: 2 },
      { key: "integration.require_base_shift_regate", value: true },
      { key: "budget.monthly_usd", value: 1000 },
      { key: "budget.per_spec_usd", value: 100 },
      { key: "budget.unknown_cost_action", value: "warn" },
      { key: "notifications.quorum", value: 1 },
      { key: "coverage.max_evidence_age_days", value: 30 },
    ]),
  },
  private: {
    sourceDocument: presetPolicy("private", [
      { key: "review.mode", value: "human" },
      { key: "review.minimum_approvals", value: 1 },
      { key: "review.freshness", value: "exact_head_sha" },
      { key: "review.require_forge_publication", value: true },
      { key: "review.dismiss_on_base_shift", value: true },
      { key: "audit.block_at", value: "P2" },
      { key: "audit.residual_disposition", value: "new_spec" },
      { key: "integration.max_unmerged_ancestor_depth", value: 1 },
      { key: "integration.require_base_shift_regate", value: true },
      { key: "budget.monthly_usd", value: 500 },
      { key: "budget.per_spec_usd", value: 50 },
      { key: "budget.unknown_cost_action", value: "pause" },
      { key: "notifications.quorum", value: 1 },
      { key: "coverage.max_evidence_age_days", value: 14 },
    ]),
  },
  regulated: {
    sourceDocument: presetPolicy("private", [
      { key: "review.mode", value: "human" },
      { key: "review.minimum_approvals", value: 2 },
      { key: "review.freshness", value: "exact_head_sha" },
      { key: "review.require_forge_publication", value: true },
      { key: "review.dismiss_on_base_shift", value: true },
      { key: "audit.block_at", value: "P3" },
      { key: "audit.residual_disposition", value: "new_spec" },
      { key: "integration.max_unmerged_ancestor_depth", value: 0 },
      { key: "integration.require_base_shift_regate", value: true },
      { key: "budget.monthly_usd", value: 250 },
      { key: "budget.per_spec_usd", value: 25 },
      { key: "budget.unknown_cost_action", value: "pause" },
      { key: "notifications.quorum", value: 2 },
      { key: "coverage.max_evidence_age_days", value: 7 },
    ]),
  },
};

export function governanceTierPreset(preset: GovernanceTierPreset): GovernanceTierPresetDefinition {
  return GOVERNANCE_TIER_PRESETS[preset];
}
