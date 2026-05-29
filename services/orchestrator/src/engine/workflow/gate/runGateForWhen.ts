// P3-0005: the loop-facing gate seam. Resolves which tiers run at a lifecycle
// point from the (already-resolved) CI config and runs each in order, stopping
// at the first tier that fails. This is what the writer loop calls — once per
// writer iteration with when="per_iteration", and once before the audit with
// when="pre_audit". The config is sourced from the repo's tanren-ci.yml when
// present and the documented P3-0004 default when absent (resolveCiConfig).
import type { CiConfigV1, CiWhen } from "../../ci/index.js";
import { tiersFor } from "../../ci/index.js";
import type { SshTarget } from "../../contracts/allocator.js";
import type { SshSubstrate } from "../../contracts/sshSubstrate.js";
import { type GateAppendEvent, type GateTierResult, runGateTier } from "./runGateTier.js";

export interface RunGateForWhenInput {
  ssh: SshSubstrate;
  target: SshTarget;
  workspacePath: string;
  config: CiConfigV1;
  when: CiWhen;
  timeoutMs: number;
  appendEvent: GateAppendEvent;
  taskId?: string;
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
    });
    results.push(result);
    if (!result.passed) {
      return { passed: false, results, failure: result };
    }
  }
  return { passed: true, results };
}
