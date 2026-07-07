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
      // apex v56 #61: a fail-closed throw on the dependent-run speculative base-assembly path.
      "speculative_assembly",
      // Codex round-3 #3 (PR #740 + #745): typed errors from worker context-hydration
      // + design-oracle pre-row paths that would otherwise alias into the opaque
      // `internal` code. Enumerating them here (mirroring `RunFailureCode`) keeps the
      // `dag.spec.redriven` payload closed-vocabulary + lets the convergence detector
      // key a real fix-point on each specific class rather than the generic bucket.
      "malformed_ancestor_stack",
      "design_contract_corrupt",
      "design_oracle_actor_config",
      "malformed_design_oracle_result",
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
    // no new information) — NOT at any hardcoded count. Nonnegative (not strictly positive) to
    // admit the `prober_resume` source's `0` value (a window-pressure resume is NOT a structural
    // re-drive and is filtered out of the convergence history reader entirely; the slot is
    // present for payload-shape uniformity only).
    consecutiveSameFailure: z.number().int().nonnegative(),
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
    // SOURCE discriminator (audit finding #13): a `dag.spec.redriven` is emitted from TWO
    // distinct call sites that MUST NOT pollute each other's convergence history:
    //   - "workflow_redrive" (the default; absent on legacy rows) — the disposition applier's
    //     real structural re-drive: a writer/checker/auditor failure routed through the
    //     `re_drive` bucket. THIS is what the convergence detector reads to find a fixed point.
    //   - "prober_resume" — `pausedRunResumeProber.resumeOne`'s spec flip on a window-pressure
    //     resume. It carries a synthetic `failureCode: "usage_limit"` only because the spec
    //     pair-schema requires SOME code for an `open` flip; the convergence reader MUST
    //     skip these rows or a sequence (workflow_redrive[internal], prober_resume[usage_limit],
    //     workflow_redrive[internal]) reads as "a new state appeared," masking a genuine cycle.
    //     The reader filters by `payload.source === "prober_resume"`.
    // OPTIONAL so existing committed rows (which carry no `source`) parse cleanly; absent ⇒
    // treat as the default `workflow_redrive`.
    source: z.enum(["workflow_redrive", "prober_resume"]).optional(),
  })
  .strict();
export type DagSpecRedrivenPayload = z.infer<typeof DagSpecRedrivenPayload>;
