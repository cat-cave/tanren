import { z } from "zod";

// P3-0005 in-loop gate-check stage. The gate is the deterministic, exit-code
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
    outputTail: z.string()
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
    stepNames: z.array(z.string())
  })
  .strict();

// gate.passed: every step in the tier exited 0. Carries the full per-step
// results for the run record.
export const GatePassedPayload = z
  .object({
    tier: z.string(),
    when: GateWhen,
    steps: z.array(GateStepResult)
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
    steps: z.array(GateStepResult)
  })
  .strict();
