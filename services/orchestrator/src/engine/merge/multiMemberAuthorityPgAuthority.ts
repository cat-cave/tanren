// Exact SP-4 authority construction + immediate freshness revalidation for MQ-2.

import type pg from "pg";
import type { BatchAuthorityBinding } from "../contracts/batchMergeCoordinator.js";
import type { CodeHost, CodeHostRepoRef } from "../contracts/codeHost.js";
import { proofReuseKey } from "../contracts/integrationNodes.js";
import type {
  LandBindingEnvelope,
  LandBindingRevalidation,
  LandBindingRevalidator,
  LandSubject,
  MergeAuthorityV2,
} from "../contracts/mergeAuthority.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import { PgIntegrationNodeModel } from "../dag/integrationNodesPg.js";
import { buildAuthorityLandStore, type LandFinalizeContext } from "./mergeAuthorityLandFinalizer.js";
import { MergeAuthorityV2Impl, subjectsEqual } from "./mergeAuthorityV2Impl.js";
import {
  loadCurrentQuarantineVersion,
  loadPersistedBatchDecisionSignals,
  rethrowTypedCodeHostInfrastructure,
  type PersistedBatchDecisionSignals,
} from "./multiMemberAuthorityEvidencePg.js";

export function buildPgExactBatchAuthority(input: {
  readonly pool: pg.Pool;
  readonly orgId: string;
  readonly binding: BatchAuthorityBinding;
  readonly envelope: LandBindingEnvelope;
  readonly host: CodeHost;
  readonly repo: CodeHostRepoRef;
  readonly intoMain: string;
  readonly context: LandFinalizeContext;
  readonly runStateWriter: RunStateWriter;
}): Pick<MergeAuthorityV2, "authorizeLand"> {
  return new MergeAuthorityV2Impl(
    input.host,
    new PgExactBatchBindingRevalidator({
      orgId: input.orgId,
      binding: input.binding,
      envelope: input.envelope,
      host: input.host,
      repo: input.repo,
      intoMain: input.intoMain,
      nodes: new PgIntegrationNodeModel(input.pool),
      readQuarantineVersion: () => loadCurrentQuarantineVersion(input.pool, input.orgId, input.context.projectId),
      readDecisionSignals: () =>
        loadPersistedBatchDecisionSignals(input.pool, input.orgId, input.context.projectId, input.binding),
    }),
    buildAuthorityLandStore(input.pool, input.context, input.runStateWriter),
  );
}

export interface PgExactBatchBindingRevalidatorDeps {
  readonly orgId: string;
  readonly binding: BatchAuthorityBinding;
  readonly envelope: LandBindingEnvelope;
  readonly host: CodeHost;
  readonly repo: CodeHostRepoRef;
  readonly intoMain: string;
  readonly nodes: PgIntegrationNodeModel;
  readonly readQuarantineVersion: () => Promise<string>;
  readonly readDecisionSignals: () => Promise<PersistedBatchDecisionSignals>;
}

/** Immediate exact DB + host freshness read used by the real SP-4 implementation. */
export class PgExactBatchBindingRevalidator implements LandBindingRevalidator {
  constructor(private readonly deps: PgExactBatchBindingRevalidatorDeps) {}

  async revalidate(input: { subject: LandSubject; envelope: LandBindingEnvelope }): Promise<LandBindingRevalidation> {
    if (!subjectsEqual(input.subject, input.envelope.subject) || input.envelope !== this.deps.envelope) {
      return invalid("authority received a different subject/envelope object");
    }
    const { binding } = this.deps;
    const [node, proof, quarantineVersion, decisionSignals] = await Promise.all([
      this.deps.nodes.findByMemberKey(this.deps.orgId, binding.memberSetHash),
      this.deps.nodes.findProof(this.deps.orgId, binding.proof.proofReuseKey),
      this.deps.readQuarantineVersion(),
      this.deps.readDecisionSignals(),
    ]);
    if (
      node === undefined ||
      node.nodeId !== binding.nodeId ||
      node.status !== "ready" ||
      node.headSha !== binding.headSha ||
      node.treeHash !== binding.treeHash ||
      node.baseSha !== binding.baseSha ||
      node.policyVersion !== binding.policyVersion ||
      node.gateConfigHash !== binding.proof.keyInput.gateConfigHash ||
      !sameMembers(node.members, binding.members)
    ) {
      return invalid("persisted integration node no longer matches the evaluated binding");
    }
    if (
      proof === undefined ||
      proof.nodeId !== binding.nodeId ||
      proof.verdict !== "passed" ||
      proofReuseKey(binding.proof.keyInput) !== binding.proof.proofReuseKey
    ) {
      return invalid("exact passing integration proof is absent or stale");
    }
    if (
      quarantineVersion !== binding.proof.keyInput.quarantineVersion ||
      decisionSignals.gateVerdict !== "passed" ||
      decisionSignals.mergeability !== "clean" ||
      decisionSignals.conflicts !== "resolved"
    ) {
      return invalid("proof evidence or active quarantine changed after evaluation");
    }
    let currentMain: string | undefined;
    let memberHeads: ReadonlyArray<string | undefined>;
    try {
      [currentMain, ...memberHeads] = await Promise.all([
        this.deps.host.fetchRef({ repo: this.deps.repo, remoteBranch: this.deps.intoMain }),
        ...binding.members.map((member) =>
          this.deps.host.fetchRef({ repo: this.deps.repo, remoteBranch: member.branch }),
        ),
      ]);
    } catch (error) {
      rethrowTypedCodeHostInfrastructure(error, binding);
    }
    if (currentMain !== binding.baseSha) return invalid("main advanced after the batch proof");
    if (memberHeads.some((head, index) => head !== binding.members[index]?.headSha)) {
      return invalid("a member branch advanced after the batch proof");
    }
    return { valid: true };
  }
}

function sameMembers(
  left: ReadonlyArray<{ specId: string; runId: string; branch: string; headSha: string }>,
  right: ReadonlyArray<{ specId: string; runId: string; branch: string; headSha: string }>,
): boolean {
  return (
    left.length === right.length &&
    left.every((member, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        member.specId === candidate.specId &&
        member.runId === candidate.runId &&
        member.branch === candidate.branch &&
        member.headSha === candidate.headSha
      );
    })
  );
}

function invalid(reason: string): LandBindingRevalidation {
  return { valid: false, reason };
}
