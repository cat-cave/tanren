// P3-0005: the loop-facing gate seam. Resolves which tiers run at a lifecycle
// point from the (already-resolved) CI config and runs each in order, stopping
// at the first tier that fails. This is what the writer loop calls — once per
// writer iteration with when="per_iteration", and once before the audit with
// when="pre_audit". The config is sourced from the repo's tanren-ci.yml when
// present and the documented P3-0004 default when absent (resolveCiConfig).
import type { CiConfigV1, CiWhen } from "../../ci/index.js";
import { tiersFor } from "../../ci/index.js";
import type { RunnerHandle } from "../../contracts/allocator.js";
import type { CommandSubstrate } from "../../contracts/commandSubstrate.js";
import { serviceAuditActor } from "../../events/schemas/audit.js";
import { type GateAppendEvent, type GateTierResult, runGateTier } from "./runGateTier.js";

export interface RunGateForWhenInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
  config: CiConfigV1;
  when: CiWhen;
  timeoutMs: number;
  appendEvent: GateAppendEvent;
  taskId?: string;
  // Plane B (P-APP-ENV-0): the project's dev+test app env, threaded to each tier
  // so the building agent's gate commands run with it. Never logged/emitted.
  appEnv?: Record<string, string>;
  // LENIENT POSTURE: advisory (warn-but-don't-block) step names, threaded to each
  // tier. Empty/absent ⇒ every step blocks (strict default, behavior unchanged).
  advisoryStepNames?: ReadonlySet<string>;
  // The commit the gate is verifying (the workspace HEAD). When present, the gate
  // emits a `gate.verdict` roll-up anchored on it — the headSha-carrying native
  // verdict CI-intelligence reduces. Absent (unit paths with no real workspace) ⇒
  // no verdict event (the per-tier gate.* events still narrate the run).
  headSha?: string;
  // AUDIT-EVIDENCE BASELINE: the versioned governance policy in effect (the project
  // config version). Stamped onto the `gate.verdict` roll-up so the merge authority's
  // verdict records WHICH policy revision it was judged under. Optional: a caller
  // without a project-governance context (a unit path) omits it — an honest absence,
  // never a fabricated version.
  policyVersion?: number;
}

// The combined result across every tier mapped to a lifecycle point. `passed`
// is true only when every tier passed (or no tier maps to the point — an empty
// gate is a vacuous pass, never a silent skip-into-failure). On failure the
// first failing tier's result is surfaced so the caller can route to rework.
export type GateOutcome =
  | { passed: true; results: GateTierResult[] }
  | {
      passed: false;
      results: GateTierResult[];
      failure: Extract<GateTierResult, { passed: false }>;
    };

export async function runGateForWhen(input: RunGateForWhenInput): Promise<GateOutcome> {
  const tiers = tiersFor(input.config, input.when);
  const results: GateTierResult[] = [];
  const startedAtMs = Date.now();
  for (const tier of tiers) {
    const steps = input.config.tiers[tier] ?? [];
    const result = await runGateTier({
      ssh: input.ssh,
      target: input.target,
      workspacePath: input.workspacePath,
      tier,
      when: input.when,
      steps,
      timeoutMs: input.timeoutMs,
      appendEvent: input.appendEvent,
      taskId: input.taskId,
      ...(input.appEnv === undefined ? {} : { appEnv: input.appEnv }),
      ...(input.advisoryStepNames === undefined ? {} : { advisoryStepNames: input.advisoryStepNames }),
    });
    results.push(result);
    if (!result.passed) {
      const outcome: GateOutcome = { passed: false, results, failure: result };
      await emitGateVerdict(input, outcome, startedAtMs);
      return outcome;
    }
  }
  const outcome: GateOutcome = { passed: true, results };
  await emitGateVerdict(input, outcome, startedAtMs);
  return outcome;
}

// Emit the `gate.verdict` roll-up for a completed gate run when a headSha anchor
// is available. The verdict flattens every executed step (across tiers) into the
// per-check grain CI-intelligence reduces, anchored on the commit the gate ran
// against. No headSha (unit paths) ⇒ no verdict (the per-tier events still fire).
async function emitGateVerdict(input: RunGateForWhenInput, outcome: GateOutcome, startedAtMs: number): Promise<void> {
  if (input.headSha === undefined || input.headSha === "") {
    return;
  }
  const steps = outcome.results.flatMap((tier) =>
    tier.steps.map((step) => ({ name: step.name, tier: tier.tier, passed: step.passed })),
  );
  await input.appendEvent(
    "gate.verdict",
    {
      when: input.when,
      headSha: input.headSha,
      passed: outcome.passed,
      durationMs: Date.now() - startedAtMs,
      tiers: outcome.results.map((tier) => tier.tier),
      steps,
      ...(outcome.passed ? {} : { failedTier: outcome.failure.tier, failedStep: outcome.failure.failedStep }),
      // AUDIT ENVELOPE: the gate runs autonomously (the service initiates it); the
      // governance policy version is threaded from the run's project config when
      // available. No approving actor — a gate verdict is a machine judgment.
      initiatingActor: serviceAuditActor,
      ...(input.policyVersion === undefined ? {} : { policyVersion: input.policyVersion }),
    },
    input.taskId,
  );
}
