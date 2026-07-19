import { z } from "zod";
import { PolicyRuleSchema } from "./policyAst.js";

/**
 * The orchestrator-owned reviewer is a separate actor from every writer.  This
 * is a governance identity, not a provider credential or a GitHub login: the
 * latter is recorded separately on the forge receipt.
 */
export const DEDICATED_REVIEWER_PRINCIPAL = {
  kind: "agent_profile",
  name: "tanren-reviewer",
} as const;

export const ReviewPrincipal = z
  .object({
    kind: z.enum(["agent_profile", "user", "team"]),
    name: z.string().min(1).max(256),
  })
  .strict();
export type ReviewPrincipal = z.infer<typeof ReviewPrincipal>;

const CompiledPolicySchema = z
  .object({
    apiVersion: z.literal("tanren.dev/governance/v2"),
    schemaVersion: z.number().int().positive(),
    aggregationOrder: z.array(z.string()),
    rules: z.array(PolicyRuleSchema),
    sourceMap: z.record(z.string(), z.unknown()),
  })
  .strict();

type ReviewMode = "auto" | "simulated" | "human";
type ReviewFreshness = "none" | "branch_head" | "exact_head_sha";

export interface ResolvedReviewRules {
  readonly kind: "resolved";
  readonly mode: ReviewMode;
  /** The effective number of distinct approving reviewers required. */
  readonly minimumApprovals: number;
  readonly freshness: ReviewFreshness;
  readonly requireForgePublication: boolean;
  readonly dismissOnBaseShift: boolean;
  readonly requiredPrincipals: readonly ReviewPrincipal[];
}

export interface UnresolvedReviewRules {
  readonly kind: "unresolved";
  readonly reason: string;
}

export type GovernanceReviewRules = ResolvedReviewRules | UnresolvedReviewRules;

export interface ReviewApprovalEvidence {
  /** Provider-observed reviewer login. Empty/missing reviewers never satisfy a rule. */
  readonly reviewer?: string;
  /** The Tanren governance actor that emitted the review. */
  readonly principal?: ReviewPrincipal;
  /** Present only for a complete strict forge publication receipt. */
  readonly forgeReviewHeadSha?: string;
}

export type ReviewEvidence =
  | { readonly kind: "observed"; readonly approvals: readonly ReviewApprovalEvidence[] }
  | { readonly kind: "unresolved"; readonly reason: string };

export interface GovernanceReviewGate {
  readonly rules: GovernanceReviewRules;
  readonly evidence: ReviewEvidence;
}

export type ReviewRuleEvaluation = { readonly kind: "passed" } | { readonly kind: "blocked"; readonly reason: string };

/** A policy with no review requirement still carries explicit observable evidence state. */
export function noRequiredReviewGate(): GovernanceReviewGate {
  return {
    rules: {
      kind: "resolved",
      mode: "auto",
      minimumApprovals: 0,
      freshness: "none",
      requireForgePublication: false,
      dismissOnBaseShift: false,
      requiredPrincipals: [],
    },
    evidence: { kind: "observed", approvals: [] },
  };
}

/**
 * Resolve the review subset of an immutable compiled policy.  A missing,
 * malformed, or internally inconsistent rule is deliberately unresolved: the
 * MergeAuthority must block rather than infer a permissive review posture.
 */
export function reviewRulesFromCompiledPolicy(input: unknown): GovernanceReviewRules {
  const parsed = CompiledPolicySchema.safeParse(input);
  if (!parsed.success) return { kind: "unresolved", reason: "effective governance review rules are malformed" };

  const values = new Map<string, unknown>();
  const principals: ReviewPrincipal[] = [];
  for (const rule of parsed.data.rules) {
    if (rule.key === "review.required_principal") {
      principals.push(rule.value);
      continue;
    }
    if (!rule.key.startsWith("review.")) continue;
    if (values.has(rule.key)) {
      return { kind: "unresolved", reason: `effective governance policy repeats ${rule.key}` };
    }
    values.set(rule.key, rule.value);
  }

  const mode = values.get("review.mode");
  const minimumApprovals = values.get("review.minimum_approvals");
  const freshness = values.get("review.freshness");
  const requireForgePublication = values.get("review.require_forge_publication");
  const dismissOnBaseShift = values.get("review.dismiss_on_base_shift");
  if (
    (mode !== "auto" && mode !== "simulated" && mode !== "human") ||
    !Number.isInteger(minimumApprovals) ||
    typeof minimumApprovals !== "number" ||
    minimumApprovals < 0 ||
    (freshness !== "none" && freshness !== "branch_head" && freshness !== "exact_head_sha") ||
    typeof requireForgePublication !== "boolean" ||
    typeof dismissOnBaseShift !== "boolean"
  ) {
    return { kind: "unresolved", reason: "effective governance policy omits a core review rule" };
  }
  if (mode === "auto" && (minimumApprovals > 0 || principals.length > 0 || requireForgePublication)) {
    return { kind: "unresolved", reason: "automatic review cannot satisfy a required reviewer rule" };
  }

  const requiredPrincipals = uniquePrincipals(
    mode === "simulated" ? [...principals, DEDICATED_REVIEWER_PRINCIPAL] : principals,
  );
  return {
    kind: "resolved",
    mode,
    // A non-auto policy is a review policy even when a malformed manual document
    // tried to set its count to zero.  Do not turn it into a silent auto-pass.
    minimumApprovals: mode === "auto" ? minimumApprovals : Math.max(minimumApprovals, 1),
    freshness,
    requireForgePublication,
    dismissOnBaseShift,
    requiredPrincipals,
  };
}

/** Required-policy evaluator used immediately before the sole MergeAuthority. */
export function evaluateReviewRules(input: {
  readonly gate: GovernanceReviewGate;
  readonly latestVerdict: "approved" | "changes_requested" | "pending" | "unread";
  readonly landingHeadSha: string;
}): ReviewRuleEvaluation {
  const { rules, evidence } = input.gate;
  if (rules.kind === "unresolved") return { kind: "blocked", reason: rules.reason };
  if (!reviewIsRequired(rules)) return { kind: "passed" };
  if (input.latestVerdict !== "approved") {
    return { kind: "blocked", reason: `required review is ${input.latestVerdict}; an approved verdict is required` };
  }
  if (evidence.kind === "unresolved") return { kind: "blocked", reason: evidence.reason };

  const approvals = evidence.approvals.filter((approval) => approvalIsUsable(approval, rules, input.landingHeadSha));
  const reviewerCount = new Set(approvals.map((approval) => approval.reviewer!.trim().toLowerCase())).size;
  if (reviewerCount < rules.minimumApprovals) {
    return {
      kind: "blocked",
      reason: `required review has ${reviewerCount}/${rules.minimumApprovals} distinct usable approvals`,
    };
  }
  for (const principal of rules.requiredPrincipals) {
    if (!approvals.some((approval) => samePrincipal(approval.principal, principal))) {
      return {
        kind: "blocked",
        reason: `required reviewer principal ${principal.kind}:${principal.name} is unresolved`,
      };
    }
  }
  return { kind: "passed" };
}

export function simulatedReviewerPrincipal(): ReviewPrincipal {
  return DEDICATED_REVIEWER_PRINCIPAL;
}

function reviewIsRequired(rules: ResolvedReviewRules): boolean {
  return rules.minimumApprovals > 0 || rules.requiredPrincipals.length > 0 || rules.requireForgePublication;
}

function approvalIsUsable(
  approval: ReviewApprovalEvidence,
  rules: ResolvedReviewRules,
  landingHeadSha: string,
): boolean {
  if (approval.reviewer === undefined || approval.reviewer.trim() === "") return false;
  if (!rules.requireForgePublication) return true;
  const receiptHead = approval.forgeReviewHeadSha;
  if (receiptHead === undefined || !/^[0-9a-f]{40}$/iu.test(receiptHead)) return false;
  return rules.freshness !== "exact_head_sha" || receiptHead.toLowerCase() === landingHeadSha.toLowerCase();
}

function uniquePrincipals(principals: readonly ReviewPrincipal[]): readonly ReviewPrincipal[] {
  const seen = new Set<string>();
  return principals.filter((principal) => {
    const key = `${principal.kind}\u0000${principal.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function samePrincipal(left: ReviewPrincipal | undefined, right: ReviewPrincipal): boolean {
  return left?.kind === right.kind && left.name === right.name;
}
