// Exact SP-4 authority construction + immediate freshness revalidation for MQ-2.

import type pg from "pg";
import type { BatchAuthorityBinding } from "../contracts/batchMergeCoordinator.js";
import type { CodeHost, CodeHostRepoRef } from "../contracts/codeHost.js";
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
import { MergeAuthorityV2Impl, subjectsEqual, type AuthorityLandStore } from "./mergeAuthorityV2Impl.js";
import {
  loadCurrentQuarantineVersion,
  loadPersistedBatchDecisionSignals,
  rethrowTypedCodeHostInfrastructure,
  type PersistedBatchDecisionSignals,
} from "./multiMemberAuthorityEvidencePg.js";
import type { GateProofBundleVerifier } from "./gateProofBundleTypes.js";
import type { RuntimeOutcomeProofCoordinate } from "../contracts/runtimeOutcome.js";

interface RuntimeOutcomeAwareLandStore extends AuthorityLandStore {
  bindRuntimeOutcome(input: RuntimeOutcomeProofCoordinate): void;
}

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
  readonly gateProofs: GateProofBundleVerifier;
  readonly landStore?: AuthorityLandStore;
}): MergeAuthorityV2 {
  const runtimeOutcome = runtimeOutcomeCoordinate(input.binding);
  const landStore =
    input.landStore ?? buildAuthorityLandStore(input.pool, { ...input.context, runtimeOutcome }, input.runStateWriter);
  if (input.landStore !== undefined) {
    if (!isRuntimeOutcomeAware(landStore)) {
      throw new TypeError("an exact V2 authority requires a runtime-outcome-aware land store");
    }
    landStore.bindRuntimeOutcome(runtimeOutcome);
  }
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
        loadPersistedBatchDecisionSignals(
          input.pool,
          input.gateProofs,
          input.orgId,
          input.context.projectId,
          input.binding,
        ),
      verifyGateProof: () =>
        input.gateProofs.verifyExact({
          orgId: input.orgId,
          projectId: input.context.projectId,
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
        }),
    }),
    landStore,
  );
}

/** Exact immutable proof/effect coordinate shared by runtime outcomes and the host CAS. */
export function runtimeOutcomeCoordinate(binding: BatchAuthorityBinding): RuntimeOutcomeProofCoordinate {
  return {
    gateProofBundleId: binding.proof.gateProofBundleId,
    proofBundleDigest: binding.proof.proofBundleDigest,
    proofRoot: binding.proof.proofRoot,
    quarantineVersion: binding.proof.keyInput.quarantineVersion,
    baseSha: binding.baseSha,
    headSha: binding.headSha,
    treeHash: binding.treeHash,
    memberSetHash: binding.memberSetHash,
    members: binding.members,
    gateConfigHash: binding.gateConfigHash,
    policyVersion: binding.policyVersion,
    runnerImage: binding.proof.keyInput.runnerImage,
    appEnvHash: binding.proof.keyInput.appEnvHash,
  };
}

function isRuntimeOutcomeAware(value: AuthorityLandStore): value is RuntimeOutcomeAwareLandStore {
  return "bindRuntimeOutcome" in value && typeof value.bindRuntimeOutcome === "function";
}

export interface PgExactBatchBindingRevalidatorDeps {
  readonly orgId: string;
  readonly binding: BatchAuthorityBinding;
  readonly envelope: LandBindingEnvelope;
  readonly host: CodeHost;
  readonly repo: CodeHostRepoRef;
  readonly intoMain: string;
  readonly nodes: PgIntegrationNodeModel;
  /** Live active-set identity; a post-evaluation quarantine drift must block the CAS. */
  readonly readQuarantineVersion: () => Promise<string>;
  readonly readDecisionSignals: () => Promise<PersistedBatchDecisionSignals>;
  /** Invoked immediately before the host CAS alongside every other freshness read. */
  readonly verifyGateProof: () => Promise<boolean>;
}

/** Immediate exact DB + host freshness read used by the real SP-4 implementation. */
export class PgExactBatchBindingRevalidator implements LandBindingRevalidator {
  constructor(private readonly deps: PgExactBatchBindingRevalidatorDeps) {}

  async revalidate(input: { subject: LandSubject; envelope: LandBindingEnvelope }): Promise<LandBindingRevalidation> {
    if (!subjectsEqual(input.subject, input.envelope.subject) || input.envelope !== this.deps.envelope) {
      return invalid("authority received a different subject/envelope object");
    }
    const { binding } = this.deps;
    let node;
    try {
      node = await this.deps.nodes.findByMemberKey(this.deps.orgId, binding.memberSetHash);
    } catch (error) {
      // gv-17: tampered/reordered/deleted member rows fail closed — never land.
      return invalid(
        error instanceof Error
          ? `member lineage invalid: ${error.message}`
          : "member lineage invalid: integration node members diverged",
      );
    }
    const [exactGateProof, quarantineVersion, decisionSignals] = await Promise.all([
      this.deps.verifyGateProof(),
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
      node.gateConfigHash !== binding.gateConfigHash ||
      !sameMembers(node.members, binding.members)
    ) {
      return invalid("persisted integration node no longer matches the evaluated binding");
    }
    if (!exactGateProof) {
      return invalid("exact sealed V2 gate proof bundle is absent, incomplete, or stale");
    }
    if (quarantineVersion !== binding.proof.keyInput.quarantineVersion) {
      return invalid("active quarantine version changed after the V2 gate proof was evaluated");
    }
    if (
      decisionSignals.gateVerdict !== "passed" ||
      decisionSignals.mergeability !== "clean" ||
      decisionSignals.conflicts !== "resolved"
    ) {
      return invalid("live decision signals no longer authorize this integration node");
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
