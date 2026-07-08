// SPEC-LOOP REDESIGN stage event payloads (demo-run · design-oracle · triage ·
// convergence) + their grouped registry. Extracted from schemas/answerer.ts (line-cap):
// answerer.ts re-exports `loopStageEventRegistry` so `EventRegistry` still spreads these
// through ONE import (keeps registry.ts under its max-dependencies cap).
import { z } from "zod";
import { oracleEventRegistry } from "./oracle.js";
import { claimEventRegistry } from "./claims.js";

const SeverityFindingPayload = z
  .object({
    id: z.string(),
    severity: z.enum(["P0", "P1", "P2", "P3"]),
    title: z.string(),
    body: z.string(),
    fixHint: z.string().optional(),
  })
  .strict();

export const DemoRunStartedPayload = z.object({ taskKind: z.string() }).strict();

// demoRun.verdict: the optional "does the thing actually work" gate's findings +
// the narration of what user-flow steps were exercised.
export const DemoRunVerdictPayload = z
  .object({
    runId: z.string(),
    summary: z.string(),
    findings: z.array(SeverityFindingPayload),
  })
  .strict();

// designOracle.{started,verdict}: the native design-fidelity ORACLE (WS-D4) stage —
// mirrors the demo-run gate's event shape; `verificationMode` is the domain-derived
// posture the oracle declared (web → render/inspect; novel → prose/typography; …).
export const DesignOracleStartedPayload = z.object({ taskKind: z.string() }).strict();
export const DesignOracleVerdictPayload = z
  .object({
    runId: z.string(),
    contractVersion: z.number().int(),
    verificationMode: z.string(),
    summary: z.string(),
    findings: z.array(SeverityFindingPayload),
  })
  .strict();

export const TriageStartedPayload = z.object({ taskKind: z.string() }).strict();

const TriageItemPayload = z
  .object({
    id: z.string(),
    kind: z.enum(["task", "spec"]),
    route: z.enum(["task", "spec"]),
    severity: z.enum(["P0", "P1", "P2", "P3"]),
    title: z.string(),
    findingIds: z.array(z.string()),
  })
  .strict();

// triage.completed: the deduped work items + their RESOLVED routes (task-here vs new
// DAG spec) + the terminal outcome (`passed` when ALL items became specs, `kept` when
// at least one routed to a task in this spec). `droppedSpecs` (default []) records any
// triage-PROPOSED spec the spec-quality gate persistently rejected — dropped from
// materialization + parked here for visibility (mirroring the audit scheduler's
// dead-letter to needs_attention) rather than sinking the whole run under autonomy.
export const TriageCompletedPayload = z
  .object({
    runId: z.string(),
    taskId: z.string(),
    outcome: z.enum(["passed", "kept"]),
    items: z.array(TriageItemPayload),
    droppedSpecs: z
      .array(
        z
          .object({ id: z.string(), title: z.string(), severity: z.enum(["P0", "P1", "P2", "P3"]), reason: z.string() })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const ConvergenceStartedPayload = z.object({ taskKind: z.string() }).strict();

// convergence.assessed: the answerer's progress/stall/velocity read + the INTELLIGENT
// escalation verdict + the loop's applied decision (continue/pass/halt). The HALT is the
// agent's `escalation` verdict ("would a human add value beyond keep going?"), NOT a count
// (apex v35 — there is no `maxConsecutiveStalls`). `consecutiveStalls` rides along as an
// OBSERVABILITY diagnostic only. The v24 cause-not-symptom fix's BLOCKING root cause signal
// (`blockingRootCauseProgress` keyed to the stable `blockingRootCauseId`) stays so a loop
// churning on a stuck blocker while peripheral findings move is visible as the stall it is.
export const ConvergenceAssessedPayload = z
  .object({
    runId: z.string(),
    taskId: z.string(),
    assessment: z.enum(["progress", "stalled", "velocity_defer"]),
    blockingRootCauseProgress: z.enum(["retired", "reduced", "unchanged", "regressed", "none"]),
    blockingRootCauseId: z.string(),
    // The intelligent escalation verdict the halt decision keys off (replacing the count).
    escalation: z.enum(["keep_going", "escalate"]),
    decision: z.enum(["continue", "pass", "halt"]),
    // Observability diagnostic — the consecutive-stall run length, NOT a bound.
    consecutiveStalls: z.number().int(),
    reasoning: z.string(),
  })
  .strict();

// convergence.stalled: the terminal HALT when the answerer's INTELLIGENT escalation verdict
// judged a human must act (a genuine decision/blocker/dead-end) — NOT a consecutive-stall
// count. The SOLE loop halt besides budget. `reason` carries the specific human-actionable
// diagnosis the agent gave.
export const ConvergenceStalledPayload = z
  .object({
    runId: z.string(),
    consecutiveStalls: z.number().int(),
    reason: z.string(),
  })
  .strict();

// SPEC-LOOP REDESIGN stage events (demo-run/triage/convergence) — grouped so EventRegistry spreads them with ONE import (keeps registry.ts under its line + max-dependencies caps). Validation/decoding unchanged.
export const loopStageEventRegistry = {
  "demoRun.started": DemoRunStartedPayload,
  "demoRun.verdict": DemoRunVerdictPayload,
  "designOracle.started": DesignOracleStartedPayload,
  "designOracle.verdict": DesignOracleVerdictPayload,
  "triage.started": TriageStartedPayload,
  "triage.completed": TriageCompletedPayload,
  "convergence.started": ConvergenceStartedPayload,
  "convergence.assessed": ConvergenceAssessedPayload,
  "convergence.stalled": ConvergenceStalledPayload,
  // §3.1 entity-risk oracle (schemas/oracle.ts) + §3.3 entity-anchored Claims (schemas/claims.ts).
  ...oracleEventRegistry,
  ...claimEventRegistry,
} as const;
