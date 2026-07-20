// mq-15 seal orchestration (pure, deps-only — no database). Given gathered `Evidence`,
// it content-addresses the pre-seal projection, ingests ordered proof-unit drafts,
// constructs + verifies + persists the bundle through the injected sole `ProofSubstrate`,
// and persists the artifact idempotently. A bundle the substrate cannot verify NEVER
// becomes a delivery. Split from the gates module purely for the file-line cap.

import {
  type BundleBindings,
  type CanonicalBody,
  type CasByteStore,
  canonicalJson,
  type Digest,
  type ProofSubstrate,
  type ProofUnitDraft,
} from "../contracts/cas.js";
import {
  encodeMergeTrainArtifactBytes,
  finalizeMergeTrainArtifact,
  MERGE_TRAIN_ARTIFACT_MEDIA_TYPE,
  type MergeTrainArtifactDraft,
  type MergeTrainArtifactV1,
} from "../contracts/mergeTrainArtifact.js";
import type { Evidence } from "./mergeTrainArtifactGates.js";

export function assembleDraftBody(evidence: Evidence): MergeTrainArtifactDraft {
  const { lineage, decision } = evidence;
  return {
    version: 1,
    schemaVersion: "merge_train_artifact.v1",
    orgId: lineage.orgId,
    projectId: lineage.projectId,
    landGroupId: evidence.completed.landGroupId,
    authorityDecisionId: evidence.completed.decisionId,
    integrationNodeId: decision.integration_node_id,
    proofRoot: decision.proof_root,
    receipt: { mainSha: evidence.receiptMainSha, auditId: evidence.receiptAuditId },
    members: evidence.members,
    deploy: {
      provider: evidence.deploy.provider,
      appId: evidence.deploy.appId,
      deploymentId: evidence.deploy.deploymentId,
      url: evidence.deploy.url,
      state: evidence.deploy.state,
    },
    demo: {
      surfaceKind: evidence.demo.surfaceKind,
      behaviorCount: evidence.demo.behaviorCount,
      passed: evidence.demo.passed,
      failed: evidence.demo.failed,
    },
  };
}

/** The pre-seal canonical body (no sealedBundle) the bundle's artifactDigest binds. */
export function preSealBody(body: MergeTrainArtifactDraft): CanonicalBody {
  return {
    landGroupId: body.landGroupId,
    authorityDecisionId: body.authorityDecisionId,
    integrationNodeId: body.integrationNodeId,
    proofRoot: body.proofRoot,
    mainSha: body.receipt.mainSha,
    members: body.members.map((member) => ({ ordinal: member.ordinal, memberKey: member.memberKey })),
  };
}

/** The canonical pre-seal bytes the bundle's `artifactDigest` content-addresses. */
export function preSealBytes(draft: MergeTrainArtifactDraft): Uint8Array {
  return new TextEncoder().encode(canonicalJson(preSealBody(draft)));
}

export function buildBindings(evidence: Evidence, artifactDigest: Digest): BundleBindings {
  const { decision } = evidence;
  return {
    integrationNodeId: decision.integration_node_id,
    memberSetHash: decision.member_set_hash,
    preparedHeadSha: decision.head_sha,
    jjTreeId: decision.head_sha,
    artifactDigest,
    expectedMainSha: decision.expected_main_sha,
    issuedAt: evidence.issuedAt,
    expiresAt: evidence.issuedAt,
    nonce: `land-group-${evidence.completed.landGroupId}`,
  };
}

/** Ordered proof-unit drafts: proof root, each member, deploy, demo. Order is signed. */
export function buildDrafts(body: MergeTrainArtifactDraft): ProofUnitDraft[] {
  const drafts: ProofUnitDraft[] = [
    {
      kind: "artifact_provenance",
      verdict: "passed",
      subjectId: body.integrationNodeId,
      body: { proofRoot: body.proofRoot },
    },
  ];
  for (const member of body.members) {
    drafts.push({
      kind: "artifact_provenance",
      verdict: "passed",
      subjectId: member.memberKey,
      body: { ordinal: member.ordinal, runId: member.runId, specId: member.specId, prNumber: member.prNumber },
    });
  }
  drafts.push({
    kind: "artifact_provenance",
    verdict: "passed",
    subjectId: body.deploy.deploymentId,
    body: { provider: body.deploy.provider, appId: body.deploy.appId, url: body.deploy.url, state: body.deploy.state },
  });
  drafts.push({
    kind: "runtime_behavior",
    verdict: "passed",
    subjectId: body.landGroupId,
    body: {
      surfaceKind: body.demo.surfaceKind,
      behaviorCount: body.demo.behaviorCount,
      passed: body.demo.passed,
      failed: body.demo.failed,
    },
  });
  return drafts;
}

export interface MergeTrainSealSink {
  persist(input: MergeTrainPersistInput): Promise<{ inserted: boolean }>;
}

export interface MergeTrainPersistInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly landGroupId: string;
  readonly authorityDecisionId: string;
  readonly integrationNodeId: string;
  readonly proofRoot: string;
  readonly receiptAuditId: string;
  readonly receiptMainSha: string;
  readonly deployProvider: string;
  readonly deployAppId: string;
  readonly deployDeploymentId: string;
  readonly demoSurfaceKind: string;
  readonly demoBehaviorCount: number;
  readonly demoPassed: number;
  readonly bundleId: string;
  readonly bundleDigest: string;
  readonly bytesDigest: string;
  readonly contentHash: string;
  readonly artifact: MergeTrainArtifactV1;
  readonly runId: string;
  readonly specId: string;
}

export interface SealDeps {
  readonly proofSubstrate: ProofSubstrate;
  readonly casByteStore: CasByteStore;
  readonly store: MergeTrainSealSink;
}

export type SealOutcome =
  | { readonly status: "sealed"; readonly inserted: boolean; readonly artifact: MergeTrainArtifactV1 }
  | { readonly status: "verification_failed"; readonly reason: string };

/**
 * Seal gathered evidence through the injected substrate, then persist idempotently.
 * A bundle the sole substrate cannot verify NEVER becomes a delivery (no persist).
 * Deps-only — no database — so both the happy path and the tamper path unit-test freely.
 */
export async function sealEvidence(deps: SealDeps, evidence: Evidence): Promise<SealOutcome> {
  const draft = assembleDraftBody(evidence);
  // The pre-seal projection is content-addressed FIRST so the bundle's `artifactDigest`
  // binding references a real CAS row (a harmless orphan blob if the seal later aborts).
  const artifactRef = await deps.casByteStore.put({
    orgId: evidence.lineage.orgId,
    bytes: preSealBytes(draft),
    mediaType: MERGE_TRAIN_ARTIFACT_MEDIA_TYPE,
  });
  const refs = await deps.proofSubstrate.ingestUnits({
    orgId: evidence.lineage.orgId,
    projectId: evidence.lineage.projectId,
    drafts: buildDrafts(draft),
  });
  const sealed = await deps.proofSubstrate.constructBundle({
    orgId: evidence.lineage.orgId,
    projectId: evidence.lineage.projectId,
    members: refs,
    bindings: buildBindings(evidence, artifactRef.digest),
  });
  const verification = await deps.proofSubstrate.verify(sealed);
  if (!verification.valid) {
    return { status: "verification_failed", reason: verification.reason ?? "invalid" };
  }
  await deps.proofSubstrate.persistBundle(sealed);

  const artifact = finalizeMergeTrainArtifact({
    ...draft,
    sealedBundle: {
      bundleId: sealed.bundleId,
      bundleDigest: sealed.bundleDigest,
      proofRoot: sealed.proofRoot,
      bytesDigest: sealed.bytesDigest,
      signingKeyId: sealed.signingKeyId,
      rootSignatureHex: Buffer.from(sealed.rootSignature).toString("hex"),
    },
  });
  const casRef = await deps.casByteStore.put({
    orgId: evidence.lineage.orgId,
    bytes: encodeMergeTrainArtifactBytes(artifact),
    mediaType: MERGE_TRAIN_ARTIFACT_MEDIA_TYPE,
  });
  const result = await deps.store.persist({
    orgId: evidence.lineage.orgId,
    projectId: evidence.lineage.projectId,
    landGroupId: evidence.completed.landGroupId,
    authorityDecisionId: evidence.completed.decisionId,
    integrationNodeId: evidence.decision.integration_node_id,
    proofRoot: evidence.decision.proof_root,
    receiptAuditId: evidence.receiptAuditId,
    receiptMainSha: evidence.receiptMainSha,
    deployProvider: evidence.deploy.provider,
    deployAppId: evidence.deploy.appId,
    deployDeploymentId: evidence.deploy.deploymentId,
    demoSurfaceKind: evidence.demo.surfaceKind,
    demoBehaviorCount: evidence.demo.behaviorCount,
    demoPassed: evidence.demo.passed,
    bundleId: sealed.bundleId,
    bundleDigest: sealed.bundleDigest,
    bytesDigest: casRef.digest,
    contentHash: artifact.contentHash,
    artifact,
    runId: evidence.lineage.runId,
    specId: evidence.lineage.specId,
  });
  return { status: "sealed", inserted: result.inserted, artifact };
}
