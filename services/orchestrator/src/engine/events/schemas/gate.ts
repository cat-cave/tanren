import { z } from "zod";
import { AuditEnvelope } from "./audit.js";

// in-loop gate-check stage. The gate is the deterministic, exit-code
// driven half of the verification split: it runs a tier's shell steps over SSH
// in the bootstrapped runner workspace and judges pass/fail purely from exit
// codes — no Answerer, no model. These events narrate that execution so the
// timeline shows exactly which steps ran, at which lifecycle point, and why a
// tier passed or failed.

// One executed step within a tier: the named shell command plus its captured
// outcome. `outputTail` is a bounded tail of combined stdout/stderr (the gate
// runner truncates to keep events small) so the failing command's diagnostic
// rides along without the whole log.
export const GateStepResult = z
  .object({
    name: z.string(),
    run: z.string(),
    exitCode: z.number().int().nullable(),
    passed: z.boolean(),
    timedOut: z.boolean(),
    outputTail: z.string(),
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

// gate.failed: a step exited nonzero (or timed out / the substrate failed).
// `failedStep` names the first failing step so consumers do not re-scan the
// array; `steps` carries every result run up to and including the failure.
export const GateFailedPayload = z
  .object({
    tier: z.string(),
    when: GateWhen,
    failedStep: z.string(),
    exitCode: z.number().int().nullable(),
    steps: z.array(GateStepResult),
  })
  .strict();

// gate.advisory_failed: under the LENIENT governance posture, an advisory step
// (lint/typecheck) exited nonzero. The step's failure is RECORDED here as a
// warning but does NOT block — the tier keeps running and the gate stays passing.
// This makes the real first-pass quality issue visible on the timeline without
// stalling a functional-but-weak autonomous build (the apex doctrine). Build/test
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
