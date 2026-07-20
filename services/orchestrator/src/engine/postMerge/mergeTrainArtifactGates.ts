// mq-15 pure, DB-free gates + seal orchestration. The watcher is a thin DB shell over
// these functions: every fail-closed DECISION (a mismatched land group, cross-project
// decision, stale receipt, wrong group-formed, unsuccessful demo, unresolved member) is
// made here over already-fetched rows, and the seal delegates entirely to the injected
// `ProofSubstrate` + `CasByteStore`. Splitting them out keeps the SQL glue small and
// lets every negative control be asserted without a database.

import type pg from "pg";
import { z } from "zod";
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
  type MergeTrainMember,
} from "../contracts/mergeTrainArtifact.js";
import type { ValidatedRunLineage } from "./runLineage.js";

export type QueryClient = Pick<pg.PoolClient, "query">;

export const CompletedPayload = z
  .object({
    projectId: z.string().min(1),
    landGroupId: z.string().min(1),
    decisionId: z.string().min(1),
    expectedMainSha: z.string().min(1),
    authorizedSha: z.string().min(1),
    mainSha: z.string().min(1),
    memberKeys: z.array(z.string().min(1)).min(1),
  })
  .strip();
export type CompletedData = z.infer<typeof CompletedPayload>;

const GroupFormedPayload = z.object({ groupId: z.string().min(1) }).strip();
const ProofRootComposedPayload = z
  .object({ integrationNodeId: z.string().min(1), proofRoot: z.string().min(1) })
  .strip();
const DeployVerifiedPayload = z
  .object({
    provider: z.string().min(1),
    appId: z.string().min(1),
    deploymentId: z.string().min(1),
    url: z.string().min(1),
    state: z.string().min(1),
  })
  .strip();
export type DeployData = z.infer<typeof DeployVerifiedPayload>;
const DemoCompletedPayload = z
  .object({
    surfaceKind: z.string().min(1),
    behaviorCount: z.number().int(),
    passed: z.number().int(),
    failed: z.number().int(),
  })
  .strip();
export type DemoData = z.infer<typeof DemoCompletedPayload>;

interface DecisionRow {
  readonly project_id: string;
  readonly integration_node_id: string;
  readonly proof_root: string;
  readonly head_sha: string;
  readonly expected_main_sha: string;
  readonly member_set_hash: string;
}
interface GroupRow {
  readonly state: string;
  readonly main_sha: string | null;
  readonly decision_id: string;
  readonly created_at: Date | string;
}
interface MemberRow {
  readonly member_key: string;
  readonly run_id: string | null;
  readonly spec_id: string | null;
  readonly pr_number: string | null;
}

/** Everything the seal needs, gathered under one org-scoped read. Absent ⇒ no-op. */
export interface Evidence {
  readonly lineage: ValidatedRunLineage;
  readonly completed: CompletedData;
  readonly decision: DecisionRow;
  readonly issuedAt: string;
  readonly receiptAuditId: string;
  readonly receiptMainSha: string;
  readonly members: MergeTrainMember[];
  readonly deploy: DeployData;
  readonly demo: DemoData;
}

// ---- Fail-closed gates (each returns false/undefined on ANY mismatch) --------------

export function landGroupSatisfies(group: GroupRow | undefined, completed: CompletedData): group is GroupRow {
  return (
    group !== undefined &&
    group.state === "completed" &&
    group.main_sha === completed.mainSha &&
    group.decision_id === completed.decisionId
  );
}

export function decisionSatisfies(
  decision: DecisionRow | undefined,
  completed: CompletedData,
  projectId: string,
): decision is DecisionRow {
  // Cross-project fail-closed: the decision must belong to THIS project.
  return (
    decision !== undefined &&
    decision.project_id === projectId &&
    decision.expected_main_sha === completed.expectedMainSha
  );
}

export function demoIsSuccessful(demo: DemoData): boolean {
  return demo.behaviorCount > 0 && demo.failed === 0 && demo.passed === demo.behaviorCount;
}

/** Map the ORDERED memberKeys to durable run identity; any gap fails closed. */
export function resolveMembers(
  rows: readonly MemberRow[],
  memberKeys: readonly string[],
): MergeTrainMember[] | undefined {
  const byKey = new Map(rows.map((row) => [row.member_key, row]));
  const members: MergeTrainMember[] = [];
  for (const [ordinal, memberKey] of memberKeys.entries()) {
    const row = byKey.get(memberKey);
    if (row === undefined || row.run_id === null || row.spec_id === null) return undefined;
    const prNumber = row.pr_number === null ? null : Number.parseInt(row.pr_number, 10);
    members.push({
      ordinal,
      memberKey,
      runId: row.run_id,
      specId: row.spec_id,
      prNumber: prNumber === null || Number.isNaN(prNumber) ? null : prNumber,
    });
  }
  return members;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Read + gate every bound input on an already-org-scoped client. Exercised in a unit
 * test with a stub `{ query }`; the negative controls all resolve to `undefined` here.
 */
export async function gatherEvidenceFromClient(
  client: QueryClient,
  lineage: ValidatedRunLineage,
  completed: CompletedData,
  runId: string,
  loadRunEvent: (eventType: string) => Promise<{ payload: unknown } | undefined>,
): Promise<Evidence | undefined> {
  const group = (
    await client.query<GroupRow>(
      "SELECT state, main_sha, decision_id, created_at FROM land_groups WHERE org_id = $1 AND id = $2",
      [lineage.orgId, completed.landGroupId],
    )
  ).rows[0];
  if (!landGroupSatisfies(group, completed)) return undefined;

  const decision = (
    await client.query<DecisionRow>(
      `SELECT project_id, integration_node_id, proof_root, head_sha, expected_main_sha, member_set_hash
         FROM authority_decisions WHERE org_id = $1 AND id = $2`,
      [lineage.orgId, completed.decisionId],
    )
  ).rows[0];
  if (!decisionSatisfies(decision, completed, lineage.projectId)) return undefined;

  const receipt = (
    await client.query<{ audit_id: string; main_sha: string }>(
      "SELECT audit_id, main_sha FROM authority_land_receipts WHERE org_id = $1 AND effect_intent_id = $2",
      [lineage.orgId, `land-group-${completed.landGroupId}`],
    )
  ).rows[0];
  if (receipt === undefined || receipt.main_sha !== group.main_sha) return undefined;

  const formedEvent = await loadRunEvent("merge.group.formed");
  const formed = formedEvent === undefined ? undefined : GroupFormedPayload.safeParse(formedEvent.payload);
  if (formed === undefined || !formed.success || formed.data.groupId !== completed.landGroupId) return undefined;

  const proofComposed = (
    await client.query<{ payload: unknown }>(
      `SELECT payload FROM events
         WHERE org_id = $1 AND project_id = $2 AND event_type = 'integration.proof_root.composed'
           AND payload->>'proofRoot' = $3 AND payload->>'integrationNodeId' = $4
         ORDER BY ts DESC, id DESC LIMIT 1`,
      [lineage.orgId, lineage.projectId, decision.proof_root, decision.integration_node_id],
    )
  ).rows[0];
  if (proofComposed === undefined || !ProofRootComposedPayload.safeParse(proofComposed.payload).success)
    return undefined;

  const memberRows = (
    await client.query<MemberRow>(
      "SELECT member_key, run_id, spec_id, pr_number FROM land_group_members WHERE org_id = $1 AND land_group_id = $2",
      [lineage.orgId, completed.landGroupId],
    )
  ).rows;
  const members = resolveMembers(memberRows, completed.memberKeys);
  if (members === undefined) return undefined;

  const deployEvent = await loadRunEvent("deploy.verified");
  const deploy = deployEvent === undefined ? undefined : DeployVerifiedPayload.safeParse(deployEvent.payload);
  if (deploy === undefined || !deploy.success) return undefined;

  const demoEvent = await loadRunEvent("demo.completed");
  const demo = demoEvent === undefined ? undefined : DemoCompletedPayload.safeParse(demoEvent.payload);
  if (demo === undefined || !demo.success || !demoIsSuccessful(demo.data)) return undefined;

  return {
    lineage,
    completed,
    decision,
    issuedAt: iso(group.created_at),
    receiptAuditId: receipt.audit_id,
    receiptMainSha: receipt.main_sha,
    members,
    deploy: deploy.data,
    demo: demo.data,
  };
}

// ---- Seal assembly (pure) ----------------------------------------------------------

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
