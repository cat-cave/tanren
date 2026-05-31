/**
 * plannerRunAdapters — the default production adapter/gate/usage-probe builders
 * for the planner loop. Extracted from plannerRun.ts to keep that file under the
 * 500-line architecture cap. These resolve the run's four role adapters from the
 * project's routing table (per-role provider DATA, not a code-level hardcode),
 * wire the lazily-resolved CI gate, and the codexbar + ccusage usage probe.
 */
import type { CiWhen } from "../ci/index.js";
import type { SshTarget } from "../contracts/allocator.js";
import type { EventName, EventPayload } from "../events/index.js";
import type { EventStore } from "../eventStore.js";
import { buildAdaptersFromRouting } from "../providers/adapterSelector.js";
import { SshCcusageAccountant, SshCodexbarUsageMonitor, SshUsageProbe, type UsageProbe } from "../usage/index.js";
import { type GateOutcome, resolveGateConfig, runGateForWhen } from "./gate/index.js";
import type { PlannerRunAdapterContext, RunPlannerLoopInput } from "./plannerRun.js";
import type { SubtaskLoopAdapters } from "./subtaskLoop.js";

// Builds the run's four role adapters (plan/write/check/audit) by resolving the
// project's effective routing table through the shared adapter selector. The
// routing is per-role provider DATA: the writer runs whatever the `write`
// chain's head names (codex/claude/opencode/...) and each answerer whatever its
// role chain names. Codex is the default ONLY because the default routing data
// (built in runExecutionContext) heads every chain with a Codex entry — there is
// no Codex hardcode here. A role whose chain is empty or names an
// unsupported/role-incapable provider is a HARD failure (EmptyRoutingChainError
// / UnsupportedProviderError from the selector) — never a silent Codex fallback.
//
// All four roles share one runId → one CODEX_HOME (codexHomeForRun) when they
// resolve to Codex, so ccusage at run end accounts for the whole run and
// codexbar reads the run's subscription account. The loop is sequential, so
// there is no concurrent write to a shared home.
export function defaultRoutingAdapters(input: RunPlannerLoopInput, ctx: PlannerRunAdapterContext): SubtaskLoopAdapters {
  const routing = input.context.routing;
  if (routing === undefined) {
    throw new Error("context.routing is required to build the run adapters from the project routing table");
  }
  return buildAdaptersFromRouting(
    {
      secrets: input.secrets,
      ssh: input.ssh,
      target: ctx.target,
      runId: ctx.runId,
      endpointBaseUrl: input.context.endpointBaseUrl,
    },
    routing,
  );
}

// Builds the production gate callback. The CI config is resolved lazily on the
// first gate call (the workspace is bootstrapped by then) and cached for the
// rest of the run, so a malformed tanren-ci.yml surfaces at the first gate
// rather than crashing the workflow before the loop starts. Each call runs the
// tiers mapped to `when` over SSH and emits gate.* through the run's store.
export function buildDefaultGate(
  input: RunPlannerLoopInput,
  target: SshTarget,
  workspacePath: string,
  eventStore: EventStore,
): (gate: { when: CiWhen; taskId?: string }) => Promise<GateOutcome> {
  const context = input.context;
  let configPromise: ReturnType<typeof resolveGateConfig> | undefined;
  const appendEvent = async <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => {
    await eventStore.append({
      runId: context.runId,
      specId: context.specId,
      projectId: context.projectId,
      taskId,
      eventType,
      payload,
    });
  };
  return async ({ when, taskId }) => {
    if (configPromise === undefined) {
      configPromise = resolveGateConfig({
        ssh: input.ssh,
        target,
        workspacePath,
        timeoutMs: input.timeoutMs,
      });
    }
    const config = await configPromise;
    return runGateForWhen({
      ssh: input.ssh,
      target,
      workspacePath,
      config,
      when,
      timeoutMs: input.timeoutMs,
      appendEvent,
      taskId,
    });
  };
}

export function defaultUsageProbe(input: RunPlannerLoopInput, ctx: PlannerRunAdapterContext): UsageProbe {
  return new SshUsageProbe({
    monitor: new SshCodexbarUsageMonitor(input.ssh),
    accountant: new SshCcusageAccountant(input.ssh),
    provider: "codex",
    cli: "codex",
    codexHome: ctx.codexHome,
    target: ctx.target,
    timeoutMs: input.timeoutMs,
    pressureThresholdPercent: input.pressureThresholdPercent,
  });
}
