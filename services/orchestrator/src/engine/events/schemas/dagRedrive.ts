import { z } from "zod";

// dag.spec.redriven (apex v35 robustness-over-recovery): a spec's run failed with a RANDOM /
// TRANSIENT / INTERNAL fault (not budget, not misconfiguration, not a human-decision), so it is
// RE-DRIVEN rather than terminally stranded — the run halts recoverable, the spec returns to
// `open`, and the walker re-enqueues it. A random failure must NEVER rest at `needs_attention`:
// a build runs until it CONVERGES, retrying transient failures, halting only for a STRUCTURAL
// reason. This is the OBSERVABLE retry (Tanren retried — it did not silently tolerate), carrying
// the consecutive-same-failure counter so a flapping-but-eventually-different spec keeps retrying
// while a truly-STUCK one (the SAME classified failure K times) escalates via needs_attention.
// Split out of `dag.ts` (file-size cap) and re-exported there so import sites are unchanged.
export const DagSpecRedrivenPayload = z
  .object({
    // The spec that was re-driven (returned to `open`) — NOT parked.
    specId: z.string(),
    // The run that just failed (its terminal status is always the recoverable `halted`).
    runId: z.string(),
    // The CLASSIFIED public-safe failure code that triggered the re-drive (the closed run-failure
    // vocabulary, never the raw error string). The same code repeating is what the counter keys off.
    failureCode: z.enum([
      "workspace",
      "credential",
      "usage_limit",
      "merge",
      "deploy",
      "empty_writer_output",
      "internal",
    ]),
    // The run STAGE the failure is attributed to (closed vocabulary), for the timeline.
    stage: z.enum(["bootstrap", "credentials", "workspace", "agent", "merge", "deploy", "run"]),
    // CONSECUTIVE prior re-drives with the SAME failure code (this one included) — the stuck-
    // detector. A DIFFERENT code (any progress) resets it to 1. At the cap K the spec escalates.
    consecutiveSameFailure: z.number().int().positive(),
    // The cap K: the consecutive-same-failure count at which the spec escalates loudly (the bound
    // is visible on the timeline — a stuck spec is never re-driven forever).
    escalateAtAttempts: z.number().int().positive(),
    // The backoff (seconds) before the walker should re-enqueue this spec so re-drives do not
    // hot-loop — grows with the consecutive-same-failure count.
    backoffSeconds: z.number().int().nonnegative(),
  })
  .strict();
export type DagSpecRedrivenPayload = z.infer<typeof DagSpecRedrivenPayload>;
