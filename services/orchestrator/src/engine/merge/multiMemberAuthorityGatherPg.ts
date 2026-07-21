// MQ-2 production gatherer: reconstruct one exact batch decision from durable
// state, invoke only SP-4 authorizeLand, and append W0 through the sole writer.

import { runWithJobOrgId } from "@tanren/db";
import type pg from "pg";
import type { BatchAuthorityBinding } from "../contracts/batchMergeCoordinator.js";
import type { MergeQueueEntry } from "../contracts/mergeCoordinator.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { ProofSubstrate } from "../contracts/cas.js";
import type { BatchAuthorityEvaluator, MultiMemberAuthorityEvaluation } from "./multiMemberAuthorityTypes.js";
import { appendMergeSignalClassification } from "./authoritySignalClassification.js";
import { evaluateMultiMemberAuthority } from "./multiMemberAuthorityEvaluator.js";
import { buildPgExactBatchAuthority } from "./multiMemberAuthorityPgAuthority.js";
import { buildMultiMemberCodeHost, type MultiMemberAuthorityHostDeps } from "./multiMemberAuthorityPgHost.js";
import { landAuthorizedGroupPg } from "./multiMemberLandGroupPg.js";
import { PgGateProofBundleVerifier } from "./gateProofBundleVerifyPg.js";
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
}
