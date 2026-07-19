// Durable input gather for the production MQ-2 evaluator. Kept separate from host
// and authority construction so every source stays within the dependency boundary.

import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { migrateProjectConfig } from "../config/projectConfig.js";
import type { BatchAuthorityBinding } from "../contracts/batchMergeCoordinator.js";
import type { ReviewVerdict } from "../contracts/dagLifecycle.js";
import type { MergeQueueEntry } from "../contracts/mergeCoordinator.js";
import type { AuthorizeLandInput, GateVerdict, LandBindingEnvelope } from "../contracts/mergeAuthority.js";
import { serviceAuditActor } from "../events/schemas/audit.js";
import {
  resolveLandTimeFindings,
  resolveLandTimeReviewGate,
  resolveLandTimeSignals,
  type GovernanceReviewGate,
} from "./landSignals.js";
import { resolveLandTimeBehaviorGate, type BehaviorLandGate } from "./behaviorLandGate.js";
import { resolveDesignRenderGate, type DesignRenderGate } from "./designRenderLandGate.js";
import { reviewVerdictFrom } from "./mergeAuthorityInputs.js";
import { evaluateReviewRules, type ReviewRuleEvaluation } from "../governance/reviewRules.js";
import { resolveEffectivePolicyBody } from "../governance/effectivePolicySnapshotStore.js";
import { batchArtifactDigest, batchProofRoot, type MemberFindingAttribution } from "./multiMemberAuthorityTypes.js";
import { loadBatchDecisionEvidence, type PersistedBatchDecisionSignals } from "./multiMemberAuthorityEvidencePg.js";

export interface ProjectAuthorityRow {
  readonly org_id: string | null;
  readonly repo_url: string;
  readonly default_branch: string;
  readonly project_config: unknown;
  readonly org_config: unknown;
}

interface MemberSignals {
  readonly attribution: MemberFindingAttribution;
  readonly reviewVerdict: ReviewVerdict | undefined;
  /** The head sha this member's PR is landing (the branch head bound in the node). */
  readonly headSha: string;
  /** gv-12 — this member run's immutable review rules + durable, actor-bound approval evidence. */
  readonly reviewGate: GovernanceReviewGate;
  /** rv-gate — this member run's runtime behavior-acceptance outcome (fail-closed when required). */
  readonly behaviorGate: BehaviorLandGate;
  /** ds-4 — this member run's design-render acceptance outcome (fail-closed when required). */
  readonly designRenderGate: DesignRenderGate;
}

/**
 * rv-gate (fix #2, MQ-2 batch land): fold every batch member's runtime behavior gate into the
 * batch gate verdict. A batch lands the WHOLE node as one head, so ANY member with a required,
 * non-passing behavior (failed OR inconclusive) must block the whole land — it maps the batch
 * `gateVerdict` to `failed` so `authorizeLand` refuses to authorize (fail-closed). A member with
 * a `not_applicable`/`passed` behavior gate never triggers it, so a batch of non-behavior members
 * still lands on its persisted gate verdict. This is coarse-but-fail-closed by design (the frozen
 * `AuthorizeLandInput` carries no behavior field); the single-run path attributes per-behavior.
 */
export function gateVerdictWithBehaviorGates(
  persistedGateVerdict: GateVerdict,
  behaviorGates: readonly BehaviorLandGate[],
): GateVerdict {
  const behaviorBlocks = behaviorGates.some((gate) => gate.kind === "failed" || gate.kind === "inconclusive");
  return behaviorBlocks ? "failed" : persistedGateVerdict;
}

/**
 * ds-4 (MQ-2 batch land): fold every batch member's DESIGN-RENDER gate into the batch gate
 * verdict, exactly like {@link gateVerdictWithBehaviorGates}. A batch lands the WHOLE node as
 * one head, so ANY member with a required, non-passing design-render outcome (failed OR
 * inconclusive) must block the whole land → maps the batch `gateVerdict` to `failed` so
 * `authorizeLand` refuses to authorize (fail-closed). A `not_applicable`/`passed` member never
 * triggers it. Coarse-but-fail-closed by design (the frozen `AuthorizeLandInput` carries no
 * design field); the single-run path attributes the exact failing scenario.
 */
export function gateVerdictWithDesignRenderGates(
  persistedGateVerdict: GateVerdict,
  designRenderGates: readonly DesignRenderGate[],
): GateVerdict {
  const designBlocks = designRenderGates.some((gate) => gate.kind === "failed" || gate.kind === "inconclusive");
  return designBlocks ? "failed" : persistedGateVerdict;
}

/**
 * gv-12 (MQ-2 batch land): fold every batch member's DEDICATED review-rule evaluation into the
 * batch gate verdict, exactly like {@link gateVerdictWithBehaviorGates} /
 * {@link gateVerdictWithDesignRenderGates}. A generic aggregated `reviewVerdict === 'approved'`
 * is NOT sufficient: governance may require a particular reviewer principal (the dedicated
 * `tanren-reviewer` actor), a minimum distinct approval count, a complete forge receipt, and
 * head freshness. Each member is evaluated against its OWN immutable review rules + durable,
 * actor-bound evidence at its OWN landing head; ANY member whose review rules BLOCK (missing,
 * malformed, stale, wrong-actor, or below the required count) forces the whole batch gate
 * verdict to `failed` so `authorizeLand` refuses to authorize (fail-closed). This closes the
 * MQ-2 fail-open where a batch of size ≥2 CAS-landed `main` on bare `review.approved` events.
 * Coarse-but-fail-closed by design (the frozen `AuthorizeLandInput` carries no review-rule
 * field); the single-run path (`authorizeAndLand`) attributes the exact failing rule.
 */
export function gateVerdictWithReviewRules(
  persistedGateVerdict: GateVerdict,
  reviewEvaluations: readonly ReviewRuleEvaluation[],
): GateVerdict {
  const reviewBlocks = reviewEvaluations.some((evaluation) => evaluation.kind === "blocked");
  return reviewBlocks ? "failed" : persistedGateVerdict;
}

/** Evaluate one member's dedicated review rules at its own landing head (fail-closed). */
export function evaluateMemberReviewRules(member: {
  readonly reviewGate: GovernanceReviewGate;
  readonly reviewVerdict: ReviewVerdict | undefined;
  readonly headSha: string;
}): ReviewRuleEvaluation {
  return evaluateReviewRules({
    gate: member.reviewGate,
    latestVerdict: member.reviewVerdict ?? "unread",
    landingHeadSha: member.headSha,
  });
}

export interface GatheredMultiMemberAuthorityState {
  readonly project: ProjectAuthorityRow;
  readonly orgId: string;
  readonly policyVersion: number;
  readonly decisionInput: AuthorizeLandInput;
  readonly memberFindings: ReadonlyArray<MemberFindingAttribution>;
}

export async function gatherMultiMemberAuthorityState(
  pool: pg.Pool,
  input: {
    readonly projectId: string;
    readonly entries: ReadonlyArray<MergeQueueEntry>;
    readonly binding: BatchAuthorityBinding;
  },
): Promise<GatheredMultiMemberAuthorityState> {
  const project = await loadProject(pool, input.projectId);
  const orgId = requireSingleOrg(input, project.org_id);
  const config = migrateProjectConfig(project.project_config);
  // gv-12 — resolve the project's effective compiled governance policy ONCE (read-only). The
  // batch is single-project/single-org (asserted above), so every member shares these immutable
  // review rules; only the per-member durable evidence differs. FAIL-CLOSED: an unresolvable
  // policy throws here, so a batch never lands on an inferred permissive review posture.
  const compiledPolicy = await runWithOrgScope(pool, orgId, (client) =>
    resolveEffectivePolicyBody(client, orgId, input.projectId),
  );
  const memberSignals = await Promise.all(
    input.binding.members.map(async (member): Promise<MemberSignals> => {
      const [findings, signals, reviewGate, behaviorGate, designRenderGate] = await Promise.all([
        resolveLandTimeFindings(pool, orgId, member.runId),
        resolveLandTimeSignals(pool, orgId, member.runId),
        resolveLandTimeReviewGate(pool, orgId, member.runId, compiledPolicy),
        resolveLandTimeBehaviorGate(pool, orgId, member.runId),
        resolveDesignRenderGate(pool, orgId, member.runId),
      ]);
      return {
        attribution: { specId: member.specId, runId: member.runId, findings },
        reviewVerdict: signals.reviewVerdict,
        headSha: member.headSha,
        reviewGate,
        behaviorGate,
        designRenderGate,
      };
    }),
  );
  const decisionEvidence = await loadBatchDecisionEvidence(pool, orgId, input.projectId, input.binding);
  return {
    project,
    orgId,
    policyVersion: config.version,
    decisionInput: decisionFromDurableState(
      input.binding,
      config.auditPosture,
      memberSignals,
      decisionEvidence.budget,
      decisionEvidence.persisted,
    ),
    memberFindings: memberSignals.map((signals) => signals.attribution),
  };
}

export function buildMultiMemberEnvelope(
  binding: BatchAuthorityBinding,
  repo: { readonly owner: string; readonly name: string },
  intoMain: string,
): LandBindingEnvelope {
  return {
    subject: { kind: "integration_node", id: binding.nodeId },
    members: binding.members.map((member) => ({ ...member, disposition: "admit" })),
    headSha: binding.headSha,
    expectedMainSha: binding.baseSha,
    artifactDigest: batchArtifactDigest(binding),
    proofRoot: batchProofRoot(binding),
    memberSetHash: binding.memberSetHash,
    policyVersion: binding.policyVersion,
    target: { repo, intoMain },
  };
}

export async function loadMultiMemberLandContext(
  pool: pg.Pool,
  orgId: string,
  input: { readonly projectId: string; readonly entries: ReadonlyArray<MergeQueueEntry> },
  policyVersion: number,
) {
  const tail = input.entries.at(-1);
  if (tail === undefined) throw new Error("MQ-2 cannot bind a land store to an empty batch");
  const taskId = await runWithOrgScope(pool, orgId, async (client) => {
    const result = await client.query<{ task_id: string }>(
      `SELECT task_id FROM tasks
        WHERE run_id = $1 AND kind = 'merge'
        ORDER BY started_at DESC NULLS LAST, task_id ASC LIMIT 1`,
      [tail.runId],
    );
    return result.rows[0]?.task_id;
  });
  if (taskId === undefined) throw new Error(`MQ-2 tail run ${tail.runId} has no durable merge task`);
  return {
    orgId,
    runId: tail.runId,
    specId: tail.specId,
    projectId: input.projectId,
    taskId,
    prUrl: tail.prUrl,
    prNumber: tail.prNumber,
    integration: "native_queue" as const,
    auditEnvelope: { policyVersion, initiatingActor: serviceAuditActor },
  };
}

function decisionFromDurableState(
  binding: BatchAuthorityBinding,
  auditPosture: AuthorizeLandInput["auditPosture"],
  signals: ReadonlyArray<MemberSignals>,
  budget: AuthorizeLandInput["budget"],
  persisted: PersistedBatchDecisionSignals,
): AuthorizeLandInput {
  const findings = signals.flatMap((member) => member.attribution.findings);
  const reviewVerdict = aggregateReview(signals.map((member) => member.reviewVerdict));
  // gv-12: evaluate EACH member's dedicated review rules against its OWN durable, actor-bound
  // evidence at its OWN landing head — a generic aggregated `approved` verdict never authorizes
  // a batch when governance requires a dedicated reviewer / receipt / count / freshness.
  const reviewEvaluations = signals.map((member) =>
    evaluateMemberReviewRules({
      reviewGate: member.reviewGate,
      reviewVerdict: member.reviewVerdict,
      headSha: member.headSha,
    }),
  );
  return {
    subject: { kind: "integration_node", id: binding.nodeId },
    // rv-gate (fix #2) + ds-4 + gv-12: any member with a required, non-passing behavior OR
    // design-render outcome, OR whose dedicated review rules BLOCK, forces the batch gate verdict
    // to `failed` so the whole group land fails closed — never lands a bad-behavior, a11y-failing,
    // or under-reviewed member.
    gateVerdict: gateVerdictWithReviewRules(
      gateVerdictWithDesignRenderGates(
        gateVerdictWithBehaviorGates(
          persisted.gateVerdict,
          signals.map((member) => member.behaviorGate),
        ),
        signals.map((member) => member.designRenderGate),
      ),
      reviewEvaluations,
    ),
    findings,
    auditPosture,
    reviewVerdict: reviewVerdictFrom(reviewVerdict),
    mergeability: persisted.mergeability,
    budget,
    demo: "not_required",
    hitlSignoff: "not_required",
    conflicts: persisted.conflicts,
  };
}

function aggregateReview(verdicts: ReadonlyArray<ReviewVerdict | undefined>): ReviewVerdict | undefined {
  if (verdicts.some((verdict) => verdict === "changes_requested")) return "changes_requested";
  return verdicts.length > 0 && verdicts.every((verdict) => verdict === "approved") ? "approved" : undefined;
}

function requireSingleOrg(
  input: { readonly projectId: string; readonly entries: ReadonlyArray<MergeQueueEntry> },
  projectOrgId: string | null,
): string {
  if (projectOrgId === null) throw new Error(`MQ-2 project ${input.projectId} has no owning org`);
  if (input.entries.some((entry) => entry.projectId !== input.projectId || entry.orgId !== projectOrgId)) {
    throw new Error("MQ-2 batch crosses its project/org boundary");
  }
  return projectOrgId;
}

async function loadProject(pool: pg.Pool, projectId: string): Promise<ProjectAuthorityRow> {
  const row = await runWithSystemScope(pool, async (client) => {
    const result = await client.query<ProjectAuthorityRow>(
      `SELECT p.org_id, p.repo_url, p.default_branch, p.config AS project_config,
              o.config AS org_config
         FROM projects p LEFT JOIN organizations o ON o.id = p.org_id
        WHERE p.project_id = $1`,
      [projectId],
    );
    return result.rows[0];
  });
  if (row === undefined) throw new Error(`MQ-2 project ${projectId} not found`);
  return row;
}
