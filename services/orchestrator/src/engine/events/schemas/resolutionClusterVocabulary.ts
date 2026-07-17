import { z } from "zod";

const Sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const ResolutionStage = z.enum(["baseline", "production", "counterfactual", "soak"]);
const VerificationOutcome = z.enum(["passed", "failed", "inconclusive"]);
const VerificationClassification = z.enum(["product_failure", "infra_failure", "stale_contract", "inconclusive"]);

// Back-half self-healing cluster vocabulary. Payloads retain only stable ids,
// closed classifications, counts, and SHA-256 digests; source/provider bodies,
// hypotheses, evidence content, and other raw material never enter events.
export const resolutionClusterEventRegistry = {
  "issue_loop.opened": z
    .object({ projectId: z.string(), issueLoopId: z.string(), sourceFindingId: z.string() })
    .strict(),
  "issue_loop.source_revision_observed": z
    .object({
      projectId: z.string(),
      issueLoopId: z.string(),
      sourceFindingId: z.string(),
      sourceRevisionHash: Sha256,
    })
    .strict(),
  "issue_loop.reopened": z
    .object({ projectId: z.string(), issueLoopId: z.string(), sourceFindingId: z.string() })
    .strict(),
  "issue_loop.verified": z
    .object({
      projectId: z.string(),
      issueLoopId: z.string(),
      resolutionJobId: z.string(),
      resolutionDecisionId: z.string(),
    })
    .strict(),
  // `triage.*` is already registered by the existing loop-stage vocabulary.
  // Migration 0070 reserves its event-type rows idempotently without replacing
  // the older emitted payload contract.
  "spec.origin.linked": z
    .object({ projectId: z.string(), issueLoopId: z.string(), specId: z.string(), sourceFindingId: z.string() })
    .strict(),
  "remediation.attempt.started": z
    .object({
      projectId: z.string(),
      issueLoopId: z.string(),
      remediationAttemptId: z.string(),
      iteration: z.number().int().positive(),
    })
    .strict(),
  "remediation.repair_routed": z
    .object({
      projectId: z.string(),
      issueLoopId: z.string(),
      remediationAttemptId: z.string(),
      specId: z.string(),
      failureSignatureHash: Sha256,
    })
    .strict(),
  "deployment.artifact.bound": z
    .object({
      projectId: z.string(),
      issueLoopId: z.string(),
      resolutionJobId: z.string(),
      releaseInstanceId: z.string(),
      artifactDigest: Sha256,
    })
    .strict(),
  "symptom.verification.started": z
    .object({
      projectId: z.string(),
      issueLoopId: z.string(),
      resolutionJobId: z.string(),
      contractId: z.string(),
      verificationRunId: z.string(),
      stage: ResolutionStage,
    })
    .strict(),
  "symptom.verification.passed": z
    .object({
      projectId: z.string(),
      issueLoopId: z.string(),
      resolutionJobId: z.string(),
      verificationRunId: z.string(),
      classification: VerificationClassification,
      assertionIds: z.array(z.string()),
      evidenceRefs: z.array(z.string()),
    })
    .strict(),
  "symptom.verification.failed": z
    .object({
      projectId: z.string(),
      issueLoopId: z.string(),
      resolutionJobId: z.string(),
      verificationRunId: z.string(),
      outcome: VerificationOutcome.extract(["failed"]),
      classification: VerificationClassification,
      assertionIds: z.array(z.string()),
      evidenceRefs: z.array(z.string()),
    })
    .strict(),
  "symptom.verification.inconclusive": z
    .object({
      projectId: z.string(),
      issueLoopId: z.string(),
      resolutionJobId: z.string(),
      verificationRunId: z.string(),
      outcome: VerificationOutcome.extract(["inconclusive"]),
      classification: VerificationClassification,
      assertionIds: z.array(z.string()),
      evidenceRefs: z.array(z.string()),
    })
    .strict(),
  "symptom.soak.completed": z
    .object({
      projectId: z.string(),
      issueLoopId: z.string(),
      resolutionJobId: z.string(),
      verificationRunId: z.string(),
      assertionIds: z.array(z.string()),
      evidenceRefs: z.array(z.string()),
    })
    .strict(),
  "resolution.authorized": z
    .object({
      projectId: z.string(),
      issueLoopId: z.string(),
      resolutionJobId: z.string(),
      resolutionDecisionId: z.string(),
      inputSnapshotHash: Sha256,
    })
    .strict(),
  "resolution.blocked": z
    .object({
      projectId: z.string(),
      issueLoopId: z.string(),
      resolutionJobId: z.string(),
      resolutionDecisionId: z.string(),
      inputSnapshotHash: Sha256,
    })
    .strict(),
  "resolution.needs_attention": z
    .object({
      projectId: z.string(),
      issueLoopId: z.string(),
      resolutionJobId: z.string(),
      resolutionDecisionId: z.string(),
      inputSnapshotHash: Sha256,
    })
    .strict(),
  "resolution.waived": z
    .object({
      projectId: z.string(),
      issueLoopId: z.string(),
      resolutionJobId: z.string(),
      resolutionDecisionId: z.string(),
      inputSnapshotHash: Sha256,
    })
    .strict(),
  "source_issue.sync.enqueued": z
    .object({
      projectId: z.string(),
      issueLoopId: z.string(),
      sourceSyncOutboxId: z.string(),
      attempt: z.number().int().nonnegative(),
    })
    .strict(),
  "source_issue.sync.succeeded": z
    .object({
      projectId: z.string(),
      issueLoopId: z.string(),
      sourceSyncOutboxId: z.string(),
      attempt: z.number().int().positive(),
    })
    .strict(),
  "source_issue.sync.failed": z
    .object({
      projectId: z.string(),
      issueLoopId: z.string(),
      sourceSyncOutboxId: z.string(),
      attempt: z.number().int().positive(),
    })
    .strict(),
  "source_issue.sync.drifted": z
    .object({
      projectId: z.string(),
      issueLoopId: z.string(),
      sourceSyncOutboxId: z.string(),
      observedRevisionHash: Sha256,
    })
    .strict(),
  "resolution.proof.sealed": z
    .object({ projectId: z.string(), issueLoopId: z.string(), resolutionJobId: z.string(), proofHash: Sha256 })
    .strict(),
} as const;
