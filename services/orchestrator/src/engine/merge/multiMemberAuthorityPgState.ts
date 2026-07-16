// Durable input gather for the production MQ-2 evaluator. Kept separate from host
// and authority construction so every source stays within the dependency boundary.

import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { migrateProjectConfig } from "../config/projectConfig.js";
import type { BatchAuthorityBinding } from "../contracts/batchMergeCoordinator.js";
import type { ReviewVerdict } from "../contracts/dagLifecycle.js";
import type { MergeQueueEntry } from "../contracts/mergeCoordinator.js";
import type { AuthorizeLandInput, LandBindingEnvelope } from "../contracts/mergeAuthority.js";
import { serviceAuditActor } from "../events/schemas/audit.js";
import { resolveLandTimeFindings, resolveLandTimeSignals } from "./landSignals.js";
import { reviewVerdictFrom } from "./mergeAuthorityInputs.js";
import {
  batchArtifactDigest,
  batchProofRoot,
  type MemberFindingAttribution,
  type MultiMemberPreAuthorityEvidence,
} from "./multiMemberAuthorityTypes.js";
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
}

export interface GatheredMultiMemberAuthorityState {
  readonly project: ProjectAuthorityRow;
  readonly orgId: string;
  readonly policyVersion: number;
  readonly decisionInput: AuthorizeLandInput;
  readonly memberFindings: ReadonlyArray<MemberFindingAttribution>;
  readonly evidence?: MultiMemberPreAuthorityEvidence;
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
  const memberSignals = await Promise.all(
    input.binding.members.map(async (member): Promise<MemberSignals> => {
      const [findings, signals] = await Promise.all([
        resolveLandTimeFindings(pool, orgId, member.runId),
        resolveLandTimeSignals(pool, orgId, member.runId),
      ]);
      return {
        attribution: { specId: member.specId, runId: member.runId, findings },
        reviewVerdict: signals.reviewVerdict,
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
    ...(decisionEvidence.evidence === undefined ? {} : { evidence: decisionEvidence.evidence }),
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
  return {
    subject: { kind: "integration_node", id: binding.nodeId },
    gateVerdict: persisted.gateVerdict,
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
