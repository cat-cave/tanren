// Event-payload schema for the native entity-change RISK ORACLE (engine/oracle,
// docs/roadmap/entity-analysis-layer.md §3.1). Split into its own schema module —
// mirroring schemas/templates.ts — so events/schemas/answerer.ts stays under its
// 500-line architecture cap. The `oracleEventRegistry` sub-registry is folded into
// `loopEventRegistry` (schemas/answerer.ts), so it reaches the EventRegistry
// WITHOUT a separate registry.ts import (keeping registry.ts under its caps).
import { z } from "zod";

// §3.1: the deterministic entity-change RISK signal the checker reasons over
// BEFORE the LLM judgement. Emitted per checker stage so the pre-LLM risk
// classification is observable. `provenance` distinguishes a real classification
// from the graceful-fallback `unknown` paths — and, per the no-silent-fallback
// doctrine, surfaces the UNEXPECTED `producer-errored` case (vs the quiet
// legitimate-absent paths) via `unexpectedFailure`. The counts are headline
// metadata (no entity bodies); nothing here is secret-bearing.
export const CheckerEntityRiskPayload = z
  .object({
    runId: z.string(),
    taskId: z.string(),
    subtaskIndex: z.number().int(),
    riskClass: z.enum(["unknown", "cosmetic", "internal-logic", "public-api-signature", "structural"]),
    provenance: z.enum(["classified", "no-producer", "producer-unsupported", "producer-errored"]),
    // True ONLY for the unexpected `producer-errored` provenance — the signal the
    // wiring layer ALSO logs loudly. The legitimate absent paths leave this false.
    unexpectedFailure: z.boolean(),
    scrutiny: z.enum(["skip", "standard", "heightened", "maximal"]),
    rationale: z.string(),
    counts: z
      .object({
        total: z.number().int(),
        cosmetic: z.number().int(),
        structural: z.number().int(),
        publicSignature: z.number().int(),
        deletedOrRenamed: z.number().int(),
      })
      .strict(),
  })
  .strict();

// The entity-risk oracle sub-registry, spread into the EventRegistry with ONE
// import (mirroring loopEventRegistry / templateEventRegistry).
export const oracleEventRegistry = {
  "checker.entity_risk": CheckerEntityRiskPayload,
} as const;
