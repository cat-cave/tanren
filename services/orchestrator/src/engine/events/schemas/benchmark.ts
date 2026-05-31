import { z } from "zod";

// Tanren-method benchmark events (docs/roadmap/tanren-method-benchmark.md §2.1).
// The post-merge HIDDEN-ACCEPT-TIER outcome. After a trial's PR merges, the
// BenchmarkRunner re-runs the cell's frozen `accept` tier — the equivalence
// oracle the config under test never sees — against the merged result over the
// same SSH/runner substrate the in-loop gate uses. A run can merge a green PR
// that still FAILS the hidden oracle: that is a real change-failure the §2.1 CFR
// augmentation captures. These two events narrate that step and feed
// `reachedAcceptGreen` on the TrialScorecard + `experiment_trials.accept_result`.
//
// The accept tier is content-addressed (§3.1): the `acceptTierHash` rides each
// event so a verdict is forensically tied to the exact frozen tier that produced
// it — a tier whose content changed is a NEW task (§6 oracle-drift), and the
// hash makes that drift detectable rather than silent.

// One executed accept-tier step: the named shell command + its captured
// outcome. Mirrors the gate.* GateStepResult shape so the timeline renders the
// accept tier identically to the in-loop gate. `outputTail` is a bounded tail of
// combined stdout/stderr (secret in the taxonomy — may surface env values).
export const BenchmarkAcceptStepResult = z
  .object({
    name: z.string(),
    run: z.string(),
    exitCode: z.number().int().nullable(),
    passed: z.boolean(),
    timedOut: z.boolean(),
    outputTail: z.string(),
  })
  .strict();
export type BenchmarkAcceptStepResult = z.infer<typeof BenchmarkAcceptStepResult>;

// benchmark.accept.passed: every step of the hidden accept tier exited 0 against
// the merged result. The trial reached the equivalence oracle green.
export const BenchmarkAcceptPassedPayload = z
  .object({
    cellId: z.string(),
    trialIndex: z.number().int().nonnegative(),
    tier: z.string(),
    acceptTierHash: z.string(),
    steps: z.array(BenchmarkAcceptStepResult),
  })
  .strict();
export type BenchmarkAcceptPassedPayload = z.infer<typeof BenchmarkAcceptPassedPayload>;

// benchmark.accept.failed: a step exited nonzero / timed out / the substrate
// failed — the merged PR did NOT satisfy the hidden oracle (a real CFR). Also
// emitted when the accept tier could not be run at all (`reason` populated, no
// steps): an un-evaluable accept is a failed accept, never a silent pass.
export const BenchmarkAcceptFailedPayload = z
  .object({
    cellId: z.string(),
    trialIndex: z.number().int().nonnegative(),
    tier: z.string(),
    acceptTierHash: z.string(),
    failedStep: z.string().nullable(),
    exitCode: z.number().int().nullable(),
    reason: z.string().nullable(),
    steps: z.array(BenchmarkAcceptStepResult),
  })
  .strict();
export type BenchmarkAcceptFailedPayload = z.infer<typeof BenchmarkAcceptFailedPayload>;
