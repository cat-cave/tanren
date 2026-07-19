// rv-22 — the STABLE, versioned response contract for the runtime-verification
// HTTP read surface (the "visible" in provable/callable/visible). Every field a
// read route surfaces is named and typed here, once. This module is the single
// source of truth the rv-read-compat guard pins against: the guard renders these
// Zod schemas to JSON Schema and fails CI if the exposed shape drifts in a
// backward-INCOMPATIBLE way (a removed / renamed / retyped field), while allowing
// a backward-COMPATIBLE additive change (a new field). See
// scripts/rv-read-compat.mjs + engine/verification/readCompat/classifyReadCompat.ts.
//
// The surface exposes verdicts AS THEY ARE — a failed/inconclusive outcome is a
// first-class member of the outcome enum, so the read surface can never launder a
// failed behavior into a passed one.

import { z, type ZodType } from "zod";

/** The frozen version tag every response carries. Bump to `v2` on a breaking change. */
export const RV_READ_SURFACE_VERSION = "v1" as const;

// --- Closed string sets (mirror the DB CHECK constraints in 0037/0079) --------
export const VerificationRunPurpose = z.enum([
  "per_iteration",
  "pre_audit",
  "pre_merge",
  "release_periodic",
  "post_merge_production",
  "manual_canary",
]);
export const VerificationRunStatus = z.enum(["planned", "running", "completed", "failed", "cancelled"]);
export const BehaviorVerdictOutcome = z.enum([
  "passed",
  "failed_product",
  "failed_verification_contract",
  "failed_visual",
  "inconclusive_infrastructure",
  "inconclusive_external",
  "cancelled_superseded",
]);
export const FlakeState = z.enum(["stable", "suspected", "confirmed", "quarantined_fragment"]);
export const VerdictGateEffect = z.enum(["blocking", "advisory"]);
export const EnvironmentLifecycleStatus = z.enum(["provisioning", "ready", "torn_down", "failed"]);

// --- Component shapes ---------------------------------------------------------

/** The verification environment a run's verdicts were produced against. */
export const VerificationEnvironmentBinding = z
  .object({
    environmentId: z.string().min(1),
    projectId: z.string().min(1),
    integrationNodeId: z.string().min(1),
    artifactDigest: z.string().min(1),
    deploymentTarget: z.string().min(1),
    environmentFingerprint: z.string().min(1),
    lifecycleStatus: EnvironmentLifecycleStatus,
  })
  .strict();
export type VerificationEnvironmentBinding = z.infer<typeof VerificationEnvironmentBinding>;

/** One immutable per-behavior verdict, exposed exactly as persisted. */
export const VerificationVerdictView = z
  .object({
    verdictId: z.string().min(1),
    behaviorRevisionId: z.string().min(1),
    outcome: BehaviorVerdictOutcome,
    requiredAssertionCount: z.number().int().nonnegative(),
    executedAssertionCount: z.number().int().nonnegative(),
    attemptCount: z.number().int().nonnegative(),
    flakeState: FlakeState,
    gateEffect: VerdictGateEffect,
    artifactDigest: z.string().min(1),
    proofUnitDigest: z.string().nullable(),
    runtimeBehaviorContextHash: z.string().min(1),
  })
  .strict();
export type VerificationVerdictView = z.infer<typeof VerificationVerdictView>;

/** Run header — the shape shared by the list and detail surfaces. */
export const VerificationRunHeader = z
  .object({
    runId: z.string().min(1),
    projectId: z.string().min(1),
    purpose: VerificationRunPurpose,
    status: VerificationRunStatus,
    specId: z.string().nullable(),
    integrationNodeId: z.string().nullable(),
    environmentId: z.string().min(1),
    artifactDigest: z.string().min(1),
    createdAt: z.coerce.date(),
    verdictCount: z.number().int().nonnegative(),
    latestOutcome: BehaviorVerdictOutcome.nullable(),
  })
  .strict();
export type VerificationRunHeader = z.infer<typeof VerificationRunHeader>;

// --- Top-level responses ------------------------------------------------------

/** GET .../verification-runs — the per-project run listing. */
export const VerificationRunList = z
  .object({
    version: z.literal(RV_READ_SURFACE_VERSION),
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    runs: z.array(VerificationRunHeader),
  })
  .strict();
export type VerificationRunList = z.infer<typeof VerificationRunList>;

/** GET .../verification-runs/:runId — one run + its environment binding + verdicts. */
export const VerificationRunDetail = z
  .object({
    version: z.literal(RV_READ_SURFACE_VERSION),
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    run: VerificationRunHeader,
    environment: VerificationEnvironmentBinding.nullable(),
    verdicts: z.array(VerificationVerdictView),
    proofBundleHref: z.string().min(1),
  })
  .strict();
export type VerificationRunDetail = z.infer<typeof VerificationRunDetail>;

/** One verdict in a behavior's cross-run history, tagged with its run context. */
export const BehaviorVerdictHistoryItem = z
  .object({
    runId: z.string().min(1),
    runPurpose: VerificationRunPurpose,
    runStatus: VerificationRunStatus,
    createdAt: z.coerce.date(),
    verdict: VerificationVerdictView,
  })
  .strict();
export type BehaviorVerdictHistoryItem = z.infer<typeof BehaviorVerdictHistoryItem>;

/** GET .../behaviors/:behaviorRevisionId/verdicts — a behavior's verdict history. */
export const BehaviorVerdictHistory = z
  .object({
    version: z.literal(RV_READ_SURFACE_VERSION),
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    behaviorRevisionId: z.string().min(1),
    latestOutcome: BehaviorVerdictOutcome.nullable(),
    verdicts: z.array(BehaviorVerdictHistoryItem),
  })
  .strict();
export type BehaviorVerdictHistory = z.infer<typeof BehaviorVerdictHistory>;

// --- Compat-guard catalog -----------------------------------------------------
// The three TOP-LEVEL responses the read surface publishes. The rv-read-compat
// guard renders exactly these and pins their JSON-Schema shape. A stable schemaId
// is embedded so the committed baseline is self-describing.
export interface VerificationReadContractDescriptor {
  readonly name: string;
  readonly schemaId: string;
  readonly zod: ZodType;
}

export const verificationReadContractCatalog: readonly VerificationReadContractDescriptor[] = [
  { name: "VerificationRunList", schemaId: "tanren.rv.read.v1.VerificationRunList", zod: VerificationRunList },
  { name: "VerificationRunDetail", schemaId: "tanren.rv.read.v1.VerificationRunDetail", zod: VerificationRunDetail },
  { name: "BehaviorVerdictHistory", schemaId: "tanren.rv.read.v1.BehaviorVerdictHistory", zod: BehaviorVerdictHistory },
];

/**
 * Render the published read-surface responses to a `{ schemaId -> JSON Schema }`
 * map. This is the SINGLE chokepoint both the guard script and the compat unit
 * test feed the classifier from, so the "current" shape they compare against the
 * committed baseline is rendered identically. Mirrors `renderContractJsonSchema`
 * in engine/schemaExport/catalog.ts (z.coerce.date() → date-time string).
 */
export function renderVerificationReadSchemas(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const descriptor of verificationReadContractCatalog) {
    out[descriptor.schemaId] = z.toJSONSchema(descriptor.zod, {
      target: "draft-2020-12",
      unrepresentable: "any",
      override: (ctx) => {
        if (ctx.zodSchema instanceof z.ZodDate) {
          ctx.jsonSchema.type = "string";
          ctx.jsonSchema.format = "date-time";
        }
      },
    }) as Record<string, unknown>;
  }
  return out;
}
