import { z } from "zod";
import { AuditEnvelope } from "./audit.js";

// in-loop gate-check stage. The gate is the deterministic, exit-code
// driven half of the verification split: it runs a tier's shell steps over SSH
// in the bootstrapped runner workspace and judges pass/fail purely from exit
// codes — no Answerer, no model. These events narrate that execution so the
// timeline shows exactly which steps ran, at which lifecycle point, and why a
// tier passed or failed.

// EVIDENCE VERDICT (apex v57 task #64): the discriminated POSITIVE-PROOF read the
// runtime gate captured for a step that declared an `evidence` contract (or whose
// legacy `junitReport` promoted to one). Carried on the step result on BOTH the pass
// AND fail branches so the timeline records the observed-vs-required counts even on
// a pass (visibility), and so the writer's rework directive can name the diagnosis
// precisely on a fail ("0 of 1 required tests ran" instead of "evidence missing").
// `observed`/`required` are open records (kind-shape-dependent) — the consumer reads
// them positionally.
export const GateStepEvidence = z
  .object({
    kind: z.enum(["junit", "artifact", "stdout-count"]),
    sufficient: z.boolean(),
    // The specific insufficiency cause when `sufficient: false`; omitted on a pass.
    reason: z
      .enum([
        "junit_missing",
        "junit_zero_tests",
        "junit_below_threshold",
        "artifact_absent",
        "artifact_too_small",
        "stdout_count_below_threshold",
      ])
      .optional(),
    observed: z.record(z.string(), z.unknown()),
    required: z.record(z.string(), z.unknown()),
  })
  .strict();
export type GateStepEvidence = z.infer<typeof GateStepEvidence>;

// REGRESSION VERDICT: the pass→fail TRANSITION judgment for a step that declared a
// `regression` contract (engine/ci/regression.ts). Carried on the step result on BOTH
// branches — on a pass it is the durable proof the comparison actually RAN (a silently
// skipped judgment and a clean one are otherwise indistinguishable on the timeline), and
// on a fail it names the tests the writer's steering lists. `regressed` is a BOUNDED
// sample (a whole-root breakage regresses thousands; the names stop informing long before
// then) — `regressedCount` is the true verdict. `unconfirmedCount` records transitions the
// confirmation re-run cleared as flakes: never blocking, but a suite quietly burning time
// on contention becomes visible here before anyone goes looking for it.
export const GateStepRegression = z
  .object({
    regressed: z.array(z.string()),
    regressedCount: z.number().int().nonnegative(),
    unconfirmedCount: z.number().int().nonnegative(),
    baselineTotal: z.number().int().nonnegative(),
    observedTotal: z.number().int().nonnegative(),
  })
  .strict();
export type GateStepRegression = z.infer<typeof GateStepRegression>;

// One executed step within a tier: the named shell command plus its captured
// outcome. `outputTail` is a bounded tail of combined stdout/stderr (the gate
// runner truncates to keep events small) so the failing command's diagnostic
// rides along without the whole log. `evidence` is the optional positive-proof
// verdict the gate harvested when the step declared an evidence contract — absent
// when the step is judged on exit code alone (the cheap per-iteration tiers).
export const GateStepResult = z
  .object({
    name: z.string(),
    run: z.string(),
    exitCode: z.number().int().nullable(),
    passed: z.boolean(),
    timedOut: z.boolean(),
    outputTail: z.string(),
    evidence: GateStepEvidence.optional(),
    // Present only for a step that declared a `regression` contract. Absent ⇒ the step
    // was judged the ordinary way (exit code, then evidence).
    regression: GateStepRegression.optional(),
  })
  .strict();
export type GateStepResult = z.infer<typeof GateStepResult>;

// The lifecycle point at which the tier ran (mirrors the CI `when` policy):
// per_iteration runs after each writer iteration; pre_audit runs before the
// audit. Carried verbatim so consumers can group gate runs by phase.
const GateWhen = z.enum(["per_iteration", "pre_audit", "pre_merge"]);

// gate.started: emitted before the first step of a tier runs. Carries the
// resolved tier name, lifecycle point, and the ordered step names about to run
// so the timeline can show an in-progress gate.
export const GateStartedPayload = z
  .object({
    tier: z.string(),
    when: GateWhen,
    stepNames: z.array(z.string()),
  })
  .strict();

// gate.passed: every step in the tier exited 0. Carries the full per-step
// results for the run record.
export const GatePassedPayload = z
  .object({
    tier: z.string(),
    when: GateWhen,
    steps: z.array(GateStepResult),
  })
  .strict();

// gate.failed: a step exited nonzero, OR (apex v57 task #64) it exited 0 but produced
// insufficient evidence to prove its declared contract ran. `failedStep` names the first
// failing step so consumers do not re-scan the array; `steps` carries every result run
// up to and including the failure. `failedReason` discriminates the cause so the writer
// rework directive (loopFindings.gateFindings / subtaskInnerLoop.gateReason) can steer
// precisely: `"exit_code"` (the historical case, default for back-compat) vs.
// `"evidence_insufficient"` (the v57 green-by-accident class — exit was 0 but the
// declared evidence was missing/zero-tests/below-threshold). `evidence` carries the
// observed-vs-required diff so the writer's iteration-1 directive names the diagnosis.
export const GateFailedPayload = z
  .object({
    tier: z.string(),
    when: GateWhen,
    failedStep: z.string(),
    exitCode: z.number().int().nullable(),
    steps: z.array(GateStepResult),
    // `"test_regression"` is the pass→fail TRANSITION class: the step's suite may be red,
    // but what FAILED the gate is specifically that a test green on the run's base tree
    // is now red, confirmed across two runs.
    failedReason: z.enum(["exit_code", "evidence_insufficient", "test_regression"]).optional(),
    evidence: GateStepEvidence.optional(),
    regression: GateStepRegression.optional(),
  })
  .strict();

// gate.advisory_failed: under the LENIENT governance posture, an advisory step
// (lint/typecheck) exited nonzero. The step's failure is RECORDED here as a
// warning but does NOT block — the tier keeps running and the gate stays passing.
// This makes the real first-pass quality issue visible on the timeline without
// stalling a functional-but-weak autonomous build. Build/test
// failures still emit `gate.failed` and block.
export const GateAdvisoryFailedPayload = z
  .object({
    tier: z.string(),
    when: GateWhen,
    advisoryStep: z.string(),
    exitCode: z.number().int().nullable(),
    outputTail: z.string(),
  })
  .strict();

// gate.quarantine_excluded: a gate STEP whose name is on the project's ACTIVE
// flaky-quarantine surface (`quarantined_tests`) exited nonzero. Its failure is
// RECORDED here but does NOT block — the tier keeps running and the gate stays
// passing for this step. This is what CLOSES the flaky→quarantine→ship loop: a
// proven-flaky step (recorded ONLY after it both passed AND failed on UNCHANGED
// code) no longer red-gates the merge while a root-cause spec is in flight. A
// CONSISTENTLY-failing step is never quarantined, so a real regression is never
// excluded. Distinct from `gate.advisory_failed` (posture-driven lint/typecheck
// leniency) — this is surface-driven and on for every posture.
export const GateQuarantineExcludedPayload = z
  .object({
    tier: z.string(),
    when: GateWhen,
    quarantinedStep: z.string(),
    exitCode: z.number().int().nullable(),
    outputTail: z.string(),
  })
  .strict();
export type GateQuarantineExcludedPayload = z.infer<typeof GateQuarantineExcludedPayload>;

// gate.publish_failed: publishing the (already-decided) gate verdict to the forge
// failed. The native gate is the merge authority — this PUBLISH only mirrors that
// verdict onto the PR for visibility/branch-protection, so a publish failure is a
// NON-fatal WARNING: the run proceeds to merge on the internal `gate.verdict`. The
// commonest cause is a token credential attempting a check-run (Apps-only → 403),
// but `publishGateVerdict` now issues a commit status, so this should be rare (a
// transient 5xx / network blip / a status that 403/404s on a locked-down repo).
// `headSha` anchors the commit; `passed` records the verdict that was being
// published; `reason` is a non-secret diagnostic (HTTP status / error class — the
// token never appears in it). Build/test gate FAILURES still emit `gate.failed`.
export const GatePublishFailedPayload = z
  .object({
    when: GateWhen,
    headSha: z.string().min(1),
    passed: z.boolean(),
    reason: z.string(),
  })
  .strict();
export type GatePublishFailedPayload = z.infer<typeof GatePublishFailedPayload>;

// One flattened gate step in the verdict roll-up: its name, the tier it ran in,
// and whether it passed. This is the native delivery model's "check" grain — the
// per-step analytics + flaky-detection unit, equivalent to a forge check-run's
// name+conclusion but produced by Tanren's own gate.
export const GateVerdictStep = z
  .object({
    name: z.string(),
    tier: z.string(),
    passed: z.boolean(),
  })
  .strict();
export type GateVerdictStep = z.infer<typeof GateVerdictStep>;

// gate.verdict: the headSha-carrying ROLL-UP of one gate run at a lifecycle point
// — the native delivery model's terminal verdict, emitted once per `runGateForWhen`
// after every mapped tier has run (or short-circuited at a failure). It is the
// native equivalent of the retired forge-CI observation: `headSha` anchors the
// commit the gate verified; `passed` is the combined verdict; `durationMs` times
// the whole gate run; `steps[]` flattens every executed step (the per-check grain
// CI-intelligence reduces for pass-rate, timing, retries, and flaky detection).
// `failedStep`/`failedTier` name the first blocking step when `passed` is false.
// The audit envelope is MERGED into the verdict's own fields (a flat payload) so
// the gate verdict — the merge authority's terminal decision — carries the
// governance policy version + the actor who drove the gate, exactly as the
// audit-evidence doctrine requires for a governing event.
export const GateVerdictPayload = z
  .object({
    when: GateWhen,
    headSha: z.string().min(1),
    passed: z.boolean(),
    durationMs: z.number().int().min(0),
    tiers: z.array(z.string()),
    steps: z.array(GateVerdictStep),
    failedTier: z.string().optional(),
    failedStep: z.string().optional(),
  })
  .extend(AuditEnvelope.shape)
  .strict();
export type GateVerdictPayload = z.infer<typeof GateVerdictPayload>;
