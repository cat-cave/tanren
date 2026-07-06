import { z } from "zod";

// Usage-accounting event payloads. The BROADER usage.* family
// (`usage.window.observed`, `usage.window.pressure`, `usage.accounting.observed`,
// `usage.read_failed`, `usage.token_accounting_failed`) still lives in
// `schemas/infra.ts` alongside the substrate-side events it shares a subject
// area with. This file peels off the LOUD run-end mandatory-accounting failure
// signal so a new invariant-hardening event lands without pushing that file
// over the 500-line file cap.

// usage.accounting_failed (Codex critic #18) — the RUN-END mandatory
// `observeRunAccounting` seam THREW. Token accounting is a mandatory invariant
// (autonomy-engine.md — "disjoint typed buckets"), so the run's terminal
// outcome is DEMOTED (`passed`→`halted`) and this LOUD, durable event surfaces
// the accounting gap to the operator + the re-drive convergence detector.
// Distinct from `usage.token_accounting_failed` (per-CLI-call parser drift) and
// `usage.read_failed` (usage-PROBE read failure). `priorOutcomeKind` preserves
// the pre-transform outcome for observability; `outcomeDemoted` is TRUE when
// the seam demoted `passed`→`halted`, FALSE when the prior outcome was already
// non-pass (the loud event still fires so the accounting gap is visible);
// `detail` is a bounded, secret-free failure tail (`Error.message` capped).
export const UsageAccountingFailedPayload = z
  .object({
    runId: z.string(),
    priorOutcomeKind: z.enum(["passed", "convergence_stalled", "halted", "budget_paused", "window_exhausted"]),
    outcomeDemoted: z.boolean(),
    detail: z.string(),
    reason: z.string(),
  })
  .strict();
