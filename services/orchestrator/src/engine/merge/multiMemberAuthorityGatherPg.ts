// MQ-2 production gatherer: reconstruct one exact batch decision from durable
// state, invoke only SP-4 authorizeLand, and append W0 through the sole writer.

import { runWithJobOrgId, runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { BatchAuthorityBinding } from "../contracts/batchMergeCoordinator.js";
import type { MergeQueueEntry } from "../contracts/mergeCoordinator.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { ProofSubstrate } from "../contracts/cas.js";
import type { BatchAuthorityEvaluator, MultiMemberAuthorityEvaluation } from "./multiMemberAuthorityTypes.js";
import { appendMergeSignalClassification } from "./authoritySignalClassification.js";
import { evaluateMultiMemberAuthority } from "./multiMemberAuthorityEvaluator.js";
import { buildPgExactBatchAuthority, runtimeOutcomeCoordinate } from "./multiMemberAuthorityPgAuthority.js";
import { buildMultiMemberCodeHost, type MultiMemberAuthorityHostDeps } from "./multiMemberAuthorityPgHost.js";
import { landAuthorizedGroupPg } from "./multiMemberLandGroupPg.js";
import { PgGateProofBundleVerifier } from "./gateProofBundleVerifyPg.js";
import { persistRuntimeOutcome } from "./runtimeOutcomeStore.js";
import {
  buildMultiMemberEnvelope,
  gatherMultiMemberAuthorityState,
  loadMultiMemberLandContext,
} from "./multiMemberAuthorityPgState.js";

export interface PgMultiMemberAuthorityEvaluatorDeps extends MultiMemberAuthorityHostDeps {
  readonly pool: pg.Pool;
  readonly runStateWriter: RunStateWriter;
  readonly proofSubstrate: ProofSubstrate;
}

/** Production MQ-2 evaluator, mandatory in the BatchMergeCoordinator assembly. */
export class PgMultiMemberAuthorityEvaluator implements BatchAuthorityEvaluator {
  constructor(private readonly deps: PgMultiMemberAuthorityEvaluatorDeps) {}

  async evaluate(input: {
    projectId: string;
    entries: ReadonlyArray<MergeQueueEntry>;
    binding: BatchAuthorityBinding;
  }): Promise<MultiMemberAuthorityEvaluation> {
    const gateProofs = new PgGateProofBundleVerifier(this.deps.pool, this.deps.proofSubstrate);
    const gathered = await gatherMultiMemberAuthorityState(this.deps.pool, gateProofs, input);
    const { host, repo } = await buildMultiMemberCodeHost(this.deps, gathered.project, gathered.orgId);
    const envelope = buildMultiMemberEnvelope(input.binding, repo, gathered.project.default_branch);
    const context = await loadMultiMemberLandContext(this.deps.pool, gathered.orgId, input, gathered.policyVersion);
    const authority = buildPgExactBatchAuthority({
      pool: this.deps.pool,
      orgId: gathered.orgId,
      binding: input.binding,
      envelope,
      host,
      repo,
      intoMain: gathered.project.default_branch,
      context,
      runStateWriter: this.deps.runStateWriter,
      gateProofs,
    });
    const result = await evaluateMultiMemberAuthority({
      binding: input.binding,
      entries: input.entries,
      decisionInput: gathered.decisionInput,
      envelope,
      authority,
      memberFindings: gathered.memberFindings,
    });
    await this.recordNonLandOutcome(gathered.orgId, input, gateProofs, result);
    const classification = result.w0;
    if (classification !== undefined) {
      const tail = input.entries.at(-1);
      await runWithJobOrgId(gathered.orgId, () =>
        appendMergeSignalClassification({
          eventStore: this.deps.runStateWriter,
          orgId: gathered.orgId,
          projectId: input.projectId,
          ...(tail !== undefined && { runId: tail.runId, specId: tail.specId }),
          classification,
        }),
      );
    }
    return result;
  }

  async landAuthorizedGroup(input: {
    projectId: string;
    entries: ReadonlyArray<MergeQueueEntry>;
    binding: BatchAuthorityBinding;
    evaluation: Extract<MultiMemberAuthorityEvaluation, { kind: "authorized_subset" }>;
    confirmBeforeLand: () => Promise<boolean>;
  }) {
    return landAuthorizedGroupPg(this.deps, input);
  }

  /**
   * A non-land authorization is terminal only while its exact V2 proof coordinate is
   * still verifiable. If it raced, throw so the coordinator re-gathers rather than
   * making a durable stale decline claim.
   */
  private async recordNonLandOutcome(
    orgId: string,
    input: { projectId: string; entries: ReadonlyArray<MergeQueueEntry>; binding: BatchAuthorityBinding },
    gateProofs: PgGateProofBundleVerifier,
    result: MultiMemberAuthorityEvaluation,
  ): Promise<void> {
    if (!("authorization" in result)) return;
    const authorization = result.authorization;
    if (authorization === undefined || authorization.decision === "authorized") return;
    const tail = input.entries.at(-1);
    if (tail === undefined) throw new Error("cannot record a runtime outcome without queue run/spec lineage");
    const verified = await gateProofs.verifyExact({
      orgId,
      projectId: input.projectId,
      nodeId: input.binding.nodeId,
      baseSha: input.binding.baseSha,
      headSha: input.binding.headSha,
      treeHash: input.binding.treeHash,
      memberSetHash: input.binding.memberSetHash,
      members: input.binding.members,
      gateConfigHash: input.binding.gateConfigHash,
      policyVersion: input.binding.policyVersion,
      proofKeyInput: input.binding.proof.keyInput,
      gateProofBundleId: input.binding.proof.gateProofBundleId,
      proofBundleDigest: input.binding.proof.proofBundleDigest,
      proofRoot: input.binding.proof.proofRoot,
    });
    if (!verified) throw new Error("cannot record a stale or unverifiable V2 non-land outcome");
    const coordinate = runtimeOutcomeCoordinate(input.binding);
    await runWithOrgScope(this.deps.pool, orgId, async (client) => {
      await persistRuntimeOutcome(
        client,
        {
          ...coordinate,
          id: `runtime-outcome:${result.evaluationId}`,
          orgId,
          projectId: input.projectId,
          decision: authorization.decision,
          result: "declined",
        },
        { orgId, projectId: input.projectId, runId: tail.runId, specId: tail.specId },
      );
    });
  }
}
