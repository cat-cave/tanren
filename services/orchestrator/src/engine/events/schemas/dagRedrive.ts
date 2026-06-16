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
    // CONSECUTIVE prior re-drives at the SAME structural FIXED POINT (this one included) — the
    // intelligent stuck-detector (apex v35; the shared `convergenceDetector`). It counts the
    // trailing run of re-drives whose failure code AND produced-work signature both match. A
    // DIFFERENT failure code OR a DIFFERENT produced work (PROGRESS) resets it to 1, so the
    // loop is UNBOUNDED while it keeps changing the failure or the work. The spec escalates
    // ONLY once this exceeds 1 (a proven fixed point — identical failure + identical work,
    // no new information) — NOT at any hardcoded count.
    consecutiveSameFailure: z.number().int().positive(),
    // The WORK signature of the run that just failed (the produced PR-head / commit sha when
    // observable) — the second fixed-point axis: identical failure but DIFFERENT work is
    // PROGRESS (the agent did something different). Absent when the run produced no
    // observable head (it failed before committing), in which case the failure code alone
    // keys the fixed point.
    workSignature: z.string().optional(),
    // The backoff (seconds) before the walker should re-enqueue this spec so re-drives do not
    // hot-loop — grows with the fixed-point streak. The backoff (NOT a counter) is the hot-loop
    // guard while the loop is unbounded.
    backoffSeconds: z.number().int().nonnegative(),
  })
  .strict();
export type DagSpecRedrivenPayload = z.infer<typeof DagSpecRedrivenPayload>;
