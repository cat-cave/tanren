import { z } from "zod";

// Mission-complete WAVE-2 governance policy-revision event vocabulary FREEZE (gv-7).
//
// The typed, versioned event names the immutable-policy-revision authority + its
// deterministic compiler emit, frozen here from the governance spec
// (docs/roadmap/mission-complete/nodes/governance.md §7 apex-provability). A barrier
// pre-flight owns the freeze so the gv-7 consumer touches zero shared vocabulary.
//
// Payload discipline: payloads carry revision IDs, project IDs, revision/schema
// NUMBERS, content HASHES, and a rule COUNT — never the policy source/AST bodies,
// tokens, or any secret. Every reachable field is therefore `public` (see
// sensitivityRules.governanceVocabulary.ts). `policy_hash` mirrors the exact
// `governance_policy_revisions.policy_hash` CHECK from migration 0047.
//
// The `integration.proof.invalidated` name is the spec's policy-drift / base-shift
// proof-invalidation event (§7 F3 + "Policy drift/TOCTOU"). It is NOT one of the
// in-3 integration.* names frozen in 0046, so it is frozen here as part of the
// governance barrier; `reason` covers both the TOCTOU (`policy_changed`) and the
// stacked-base-shift (`base_shifted`) causes so no second freeze is ever needed.

const Sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const Id = z.string().min(1).max(256);
const RevisionNumber = z.number().int().min(1);
const SchemaVersion = z.number().int().min(1);

// ---------------------------------------------------------------------------
// governance.policy.* — the immutable revision lifecycle.
// ---------------------------------------------------------------------------

export const GovernancePolicyCreatedPayload = z
  .object({
    revisionId: Id,
    projectId: Id,
    revisionNumber: RevisionNumber,
    schemaVersion: SchemaVersion,
    parentRevisionId: Id.optional(),
    createdBy: Id,
  })
  .strict();

export const GovernancePolicyCompiledPayload = z
  .object({
    revisionId: Id,
    projectId: Id,
    revisionNumber: RevisionNumber,
    policyHash: Sha256Digest,
    ruleCount: z.number().int().min(0),
  })
  .strict();

export const GovernancePolicyActivatedPayload = z
  .object({
    revisionId: Id,
    projectId: Id,
    revisionNumber: RevisionNumber,
    policyHash: Sha256Digest,
  })
  .strict();

// gv-10 — governance fragments own a distinct F2 lifecycle. Payloads expose
// stable ids, bounded diagnostics, and digests only; policy bodies stay in the
// org-scoped registry and never cross the event boundary.
export const GovernanceFragmentAuthoringStartedPayload = z.object({ fragmentId: Id, version: Id }).strict();
export const GovernanceFragmentAuthoringAttemptPayload = z
  .object({ fragmentId: Id, attempt: z.number().int().min(1), signature: Id, rejection: Id.nullable() })
  .strict();
export const GovernanceFragmentAuthoringSucceededPayload = z
  .object({ fragmentId: Id, version: Id, fragmentDigest: Sha256Digest })
  .strict();
export const GovernanceFragmentAuthoringFailedPayload = z
  .object({ fragmentId: Id, attempts: z.number().int().min(0), reason: Id })
  .strict();

// ---------------------------------------------------------------------------
// integration.proof.invalidated — policy-drift / base-shift proof invalidation.
// ---------------------------------------------------------------------------

export const IntegrationProofInvalidatedPayload = z
  .object({
    reason: z.enum(["policy_changed", "base_shifted"]),
    projectId: Id,
    proofUnitDigest: Id,
    policyHash: Sha256Digest.optional(),
  })
  .strict();

export const governanceVocabularyRegistry = {
  "governance.policy.created": GovernancePolicyCreatedPayload,
  "governance.policy.compiled": GovernancePolicyCompiledPayload,
  "governance.policy.activated": GovernancePolicyActivatedPayload,
  "governanceFragment.authoring.started": GovernanceFragmentAuthoringStartedPayload,
  "governanceFragment.authoring.attempt": GovernanceFragmentAuthoringAttemptPayload,
  "governanceFragment.authoring.succeeded": GovernanceFragmentAuthoringSucceededPayload,
  "governanceFragment.authoring.failed": GovernanceFragmentAuthoringFailedPayload,
  "integration.proof.invalidated": IntegrationProofInvalidatedPayload,
} as const satisfies Record<string, z.ZodTypeAny>;
