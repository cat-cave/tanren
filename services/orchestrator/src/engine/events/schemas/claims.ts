// Event-payload schemas for entity-anchored issue CLAIMS — the Tanren-native
// defect ledger (docs/roadmap/entity-analysis-layer.md §3.3, the surviving
// lodestar thread). Split into its own schema module — mirroring schemas/oracle.ts
// / schemas/templates.ts — so events/schemas/answerer.ts stays under its 500-line
// architecture cap. The `claimEventRegistry` sub-registry is folded into
// `loopEventRegistry` (schemas/answerer.ts), so it reaches the EventRegistry
// WITHOUT a separate registry.ts import (keeping registry.ts under its caps).
import { z } from "zod";

// `forge.claim.anchored` — a triage one-shot became a DURABLE Claim, anchored to
// the issue's target entity by its structural-hash identity (§2.3 → §3.3). All
// fields are product-quality narration (entity identity + a defect provenance
// link), never secret-bearing.
export const ClaimAnchoredPayload = z
  .object({
    claimId: z.string(),
    orgId: z.string(),
    projectId: z.string(),
    // The candidate (issue/finding) the Claim was anchored from; null when anchored
    // outside the inbox.
    candidateId: z.string().nullable(),
    // The entity's structural-hash IDENTITY (survives a rename/move) + its display
    // anchor at anchor time.
    entityId: z.string(),
    entityKind: z.string(),
    entityName: z.string(),
  })
  .strict();

// `forge.claim.self_resolved` — the self-validating oracle saw POSITIVE evidence
// the entity is GONE and resolved the Claim. The durable form of §2.3's stale-issue
// resolution.
export const ClaimSelfResolvedPayload = z
  .object({
    claimId: z.string(),
    orgId: z.string(),
    projectId: z.string(),
    entityId: z.string(),
    entityName: z.string(),
    // The decidability tier of the validation that resolved it (always `decidable`
    // for a self-resolve — carried for symmetry with the validated event).
    decidability: z.enum(["decidable", "needs_agent", "unchecked"]),
    rationale: z.string(),
  })
  .strict();

// `forge.claim.validated` — a self-validation re-check ran but the Claim STAYS
// OPEN (entity still present / modified / renamed, OR the producer was unavailable
// so there was no evidence to resolve on). `keptOpenReason` carries WHY, and
// `unexpectedUnavailable` flags the loud `producer-errored` case (vs the quiet
// legitimate-absent paths) per the no-silent-fallback doctrine.
export const ClaimValidatedPayload = z
  .object({
    claimId: z.string(),
    orgId: z.string(),
    projectId: z.string(),
    entityId: z.string(),
    // The probe outcome that kept the Claim open.
    probeStatus: z.enum(["present", "modified", "renamed", "unavailable"]),
    decidability: z.enum(["decidable", "needs_agent", "unchecked"]),
    // True ONLY for the unexpected `producer-errored` absence — the signal the
    // wiring layer ALSO logs loudly. The legitimate absent/present paths leave it false.
    unexpectedUnavailable: z.boolean(),
    rationale: z.string(),
  })
  .strict();

// The Claim-ledger sub-registry, spread into the EventRegistry with ONE import
// (mirroring oracleEventRegistry / templateEventRegistry).
export const claimEventRegistry = {
  "forge.claim.anchored": ClaimAnchoredPayload,
  "forge.claim.self_resolved": ClaimSelfResolvedPayload,
  "forge.claim.validated": ClaimValidatedPayload,
} as const;
