// mq-1: re-authorize a land block via MA-V2 and append W0 classification facts.
// Soft-leased helper so mergeLandPaths stays under the 500-line cap.

import { createHash } from "node:crypto";
import { parseDigest } from "../contracts/cas.js";
import type { CodeHost, CodeHostRepoRef } from "../contracts/codeHost.js";
import type { PullRequestMergeability } from "../contracts/codeHostTypes.js";
import type { LandSubject } from "../contracts/mergeAuthority.js";
import type { Finding } from "../contracts/findings.js";
import type { AuditPosture } from "../contracts/auditPosture.js";
import type { ReviewVerdict } from "../contracts/dagLifecycle.js";
import type { GateOutcome } from "../workflow/gate/index.js";
import { memberKey as computeMemberKey } from "../contracts/integrationNodes.js";
import type { EventStore } from "../eventStore.js";
import type { AuditEnvelope } from "../events/schemas/audit.js";
import {
  classifyAndAppendAuthorityDecision,
  type MergeSignalClassificationV1,
} from "./authoritySignalClassification.js";
import {
  buildAuthorizeLandInput,
  type RawBudgetScope,
  type RawDemoVerification,
  type RawHitlSignoff,
} from "./mergeAuthorityInputs.js";
import type { AuthorityLandStore } from "./mergeAuthorityV2Impl.js";
import { MergeAuthorityV2Impl, SubjectEqualityRevalidator } from "./mergeAuthorityV2Impl.js";
import type { LandFinalizeContext } from "./mergeAuthorityLandFinalizer.js";

function contentDigest(body: unknown) {
  return parseDigest(`sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`);
}

export interface LandBlockSignalSource {
  readonly codeHost: CodeHost;
  readonly orgId: string;
  readonly landStoreFor: (context: LandFinalizeContext) => AuthorityLandStore;
  readonly gateConfigHash: string;
  readonly policyVersion: string;
  readonly gateOutcome: GateOutcome | undefined;
  readonly findings: ReadonlyArray<Finding>;
  readonly auditPosture: AuditPosture;
  readonly reviewVerdict: ReviewVerdict | undefined;
  readonly budget: RawBudgetScope;
  readonly demo: RawDemoVerification | undefined;
  readonly hitlSignoff: RawHitlSignoff | undefined;
}

export interface ClassifyLandAuthorityBlockForRunInput {
  readonly bundle: LandBlockSignalSource;
  readonly eventStore: EventStore;
  readonly mergeability: PullRequestMergeability;
  readonly reasons: ReadonlyArray<string>;
  readonly orgId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly specId: string;
  readonly taskId: string;
  readonly prUrl: string;
  readonly prNumber: number;
  readonly repo: CodeHostRepoRef;
  readonly intoMain: string;
  readonly integration: "direct_merge" | "native_queue";
  readonly auditEnvelope: AuditEnvelope;
}

/** Re-run authorizeLand (decision only), classify, append W0 facts; never lands. */
export async function classifyLandAuthorityBlockForRun(
  input: ClassifyLandAuthorityBlockForRunInput,
): Promise<{ classification: MergeSignalClassificationV1; message: string }> {
  const { bundle, mergeability } = input;
  const subject: LandSubject = { kind: "integration_node", id: `land-${input.runId}` };
  const headBranch = mergeability.headBranch;
  const headSha =
    (headBranch === "" ? undefined : await bundle.codeHost.fetchRef({ repo: input.repo, remoteBranch: headBranch })) ??
    "";
  const expectedMainSha = (await bundle.codeHost.fetchRef({ repo: input.repo, remoteBranch: input.intoMain })) ?? "";
  const memberSetHash = computeMemberKey(expectedMainSha, headSha === "" ? [] : [headSha]);
  const envelope = {
    subject,
    members: [
      {
        specId: input.specId,
        runId: input.runId,
        branch: headBranch,
        headSha,
        disposition: "admit" as const,
      },
    ],
    headSha,
    expectedMainSha,
    artifactDigest: contentDigest({ repo: input.repo, intoMain: input.intoMain, headSha }),
    proofRoot: contentDigest({
      memberSetHash,
      gateConfigHash: bundle.gateConfigHash,
      policyVersion: bundle.policyVersion,
      headSha,
    }),
    memberSetHash,
    policyVersion: bundle.policyVersion,
    target: { repo: input.repo, intoMain: input.intoMain },
  };
  const decisionInput = buildAuthorizeLandInput({
    subject,
    gateOutcome: bundle.gateOutcome,
    findings: bundle.findings,
    auditPosture: bundle.auditPosture,
    reviewVerdict: bundle.reviewVerdict,
    mergeability,
    budget: bundle.budget,
    demo: bundle.demo,
    hitlSignoff: bundle.hitlSignoff,
    conflictsResolved: mergeability.state !== "dirty",
  });
  const store = bundle.landStoreFor({
    orgId: bundle.orgId,
    runId: input.runId,
    specId: input.specId,
    projectId: input.projectId,
    taskId: input.taskId,
    prUrl: input.prUrl,
    prNumber: input.prNumber,
    integration: input.integration,
    auditEnvelope: input.auditEnvelope,
  });
  const authorization = await new MergeAuthorityV2Impl(
    bundle.codeHost,
    new SubjectEqualityRevalidator(),
    store,
  ).authorizeLand(decisionInput, envelope);
  return classifyAndAppendAuthorityDecision({
    decisionInput,
    envelope,
    authorization,
    eventStore: input.eventStore,
    orgId: input.orgId,
    projectId: input.projectId,
    runId: input.runId,
    specId: input.specId,
    reasons: input.reasons,
  });
}
