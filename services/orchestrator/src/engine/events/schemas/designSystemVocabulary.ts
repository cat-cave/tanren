import { z } from "zod";

// ds-0 mission-complete DESIGN-SYSTEM event vocabulary FREEZE (SP-8 barrier).
//
// The registered event schemas the executable design-system engine emits, frozen
// here EXACTLY from the design bucket's "APEX-PROVABILITY" table (§7 of
// docs/roadmap/mission-complete/nodes/design-engine-surfaces-phasing-risks.md).
// ds-0 owns its own wave, so it freezes the whole design vocabulary in one PR;
// downstream nodes (ds-3 authoring, ds-4 render/oracle, ds-5 binding, ds-6
// proof-reuse/bisection) emit these already-frozen names + strict payloads.
//
// Names already present in the live EventRegistry — `gate.verdict`,
// `designOracle.verdict`, `merge.batch.*`, `deploy.*`, `demo.*` — are REUSED by
// the design pipeline, not redeclared here. `designOracle.verdict` is
// pre-existing; its §7 payload expansion is deferred to ds-4. Only the
// genuinely new design names are frozen.
//
// Payload discipline: payloads carry stable IDs, content digests, counts, and
// closed-vocab classifications — NO rendered bytes, screenshots, secrets, or
// provider bodies. Every field is therefore `public` (see
// sensitivityRules.designSystem.ts). Envelope columns (org_id / project_id /
// spec_id / run_id) are stamped by the EventStore and never duplicated here.

const Sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const Id = z.string().min(1).max(256);
const Count = z.number().int().min(0);
const Attempt = z.number().int().min(1);
const Version = z.number().int().min(1);
const Reason = z.string().min(1).max(200);
const RenderVerdict = z.enum(["passed", "failed"]);
const PinMode = z.enum(["release", "channel"]);

// ---------------------------------------------------------------------------
// designSystem.curation.* / base.composed / fragment.missing — plain→polished.
// ---------------------------------------------------------------------------

export const DesignSystemCurationStartedPayload = z
  .object({
    curationId: Id,
    contractVersion: Version,
    contractDigest: Sha256Digest,
    targetProfiles: z.array(z.string().min(1).max(120)).max(64),
    plainBaseReleaseId: Id,
    expectedBehaviorRefCount: Count,
    expectedPersonaRefCount: Count,
  })
  .strict();

export const DesignSystemBaseComposedPayload = z
  .object({
    curationId: Id,
    plainArtifactDigest: Sha256Digest,
    catalogBuildDigest: Sha256Digest,
    tokenResolutionDigest: Sha256Digest,
  })
  .strict();

export const DesignSystemFragmentMissingPayload = z
  .object({
    curationId: Id,
    capability: z.string().min(1).max(200),
    dependencyPath: z.array(z.string().min(1).max(200)).max(256),
  })
  .strict();

// ---------------------------------------------------------------------------
// designFragment.authoring.* — F2D per-fragment authoring loop (ds-3).
// ---------------------------------------------------------------------------

export const DesignFragmentAuthoringStartedPayload = z
  .object({
    fragmentAuthoringRunId: Id,
    fragmentKind: z.string().min(1).max(200),
    fragmentLabel: z.string().min(1).max(200),
  })
  .strict();

export const DesignFragmentAuthoringAttemptPayload = z
  .object({
    fragmentAuthoringRunId: Id,
    attempt: Attempt,
    workspaceChangeId: Id,
    rejectionSignature: Id.nullable(),
  })
  .strict();

export const DesignFragmentAuthoringSucceededPayload = z
  .object({
    fragmentAuthoringRunId: Id,
    fragmentReleaseId: Id,
    fragmentDigest: Sha256Digest,
    fragmentVersion: z.string().min(1).max(128),
  })
  .strict();

export const DesignFragmentAuthoringFailedPayload = z
  .object({
    fragmentAuthoringRunId: Id,
    attempts: Count,
    reason: Reason,
  })
  .strict();

// ---------------------------------------------------------------------------
// designSystem.candidate.composed / artifact.validated — candidate + validation.
// ---------------------------------------------------------------------------

export const DesignSystemCandidateComposedPayload = z
  .object({
    curationId: Id,
    candidateReleaseId: Id,
    candidateArtifactId: Id,
    fragmentGraphDigest: Sha256Digest,
    plainToPolishedDiffDigest: Sha256Digest,
  })
  .strict();

export const DesignSystemArtifactValidatedPayload = z
  .object({
    releaseId: Id,
    artifactId: Id,
    artifactDigest: Sha256Digest,
    validationRunId: Id,
    expectedMatrixDigest: Sha256Digest,
  })
  .strict();

// ---------------------------------------------------------------------------
// designRender.scenario.recorded — A4 evidence (ds-4).
// ---------------------------------------------------------------------------

export const DesignRenderScenarioRecordedPayload = z
  .object({
    validationRunId: Id,
    evidenceId: Id,
    artifactDigest: Sha256Digest,
    scenarioKey: z.string().min(1).max(256),
    personaRef: Id.nullable(),
    behaviorRef: Id.nullable(),
    themeContext: z.string().min(1).max(120),
    viewport: z.string().min(1).max(64),
    screenshotDigest: Sha256Digest,
    verdict: RenderVerdict,
  })
  .strict();

// ---------------------------------------------------------------------------
// designSystem.release.published / proof.reused / regression.bisected /
// binding.updated — publication, reuse, queue bisection, and rollout (ds-5/6).
// ---------------------------------------------------------------------------

export const DesignSystemReleasePublishedPayload = z
  .object({
    releaseId: Id,
    designSystemId: Id,
    version: Version,
    manifestDigest: Sha256Digest,
    signature: z.string().min(1).max(512),
    validationRunId: Id,
    publishedBy: Id,
  })
  .strict();

export const DesignSystemProofReusedPayload = z
  .object({
    validationRunId: Id,
    reusedProofId: Id,
    proofReuseKey: Sha256Digest,
    releaseId: Id,
  })
  .strict();

export const DesignSystemRegressionBisectedPayload = z
  .object({
    groupId: Id,
    failingMatrixCell: z.string().min(1).max(256),
    batchId: Id,
    testedPrefixCount: Count,
    culpritReleaseId: Id,
  })
  .strict();

export const DesignSystemBindingUpdatedPayload = z
  .object({
    projectId: Id,
    bindingId: Id,
    oldReleaseId: Id.nullable(),
    newReleaseId: Id,
    pinMode: PinMode,
    generatedUpgradeSpecIds: z.array(Id).max(4096),
  })
  .strict();

export const designSystemVocabularyRegistry = {
  "designSystem.curation.started": DesignSystemCurationStartedPayload,
  "designSystem.base.composed": DesignSystemBaseComposedPayload,
  "designSystem.fragment.missing": DesignSystemFragmentMissingPayload,
  "designFragment.authoring.started": DesignFragmentAuthoringStartedPayload,
  "designFragment.authoring.attempt": DesignFragmentAuthoringAttemptPayload,
  "designFragment.authoring.succeeded": DesignFragmentAuthoringSucceededPayload,
  "designFragment.authoring.failed": DesignFragmentAuthoringFailedPayload,
  "designSystem.candidate.composed": DesignSystemCandidateComposedPayload,
  "designSystem.artifact.validated": DesignSystemArtifactValidatedPayload,
  "designRender.scenario.recorded": DesignRenderScenarioRecordedPayload,
  "designSystem.release.published": DesignSystemReleasePublishedPayload,
  "designSystem.proof.reused": DesignSystemProofReusedPayload,
  "designSystem.regression.bisected": DesignSystemRegressionBisectedPayload,
  "designSystem.binding.updated": DesignSystemBindingUpdatedPayload,
} as const satisfies Record<string, z.ZodTypeAny>;
