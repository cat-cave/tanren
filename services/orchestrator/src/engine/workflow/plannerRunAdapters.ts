/**
 * plannerRunAdapters — the default production adapter/gate/usage-probe builders
 * for the planner loop. Extracted from plannerRun.ts to keep that file under the
 * 500-line architecture cap. These wire the run's single Codex credential/home
 * into the four role answerers, the lazily-resolved CI gate, and the codexbar +
 * ccusage usage probe.
 */
import type { AuditAnswer, CheckAnswer, PlanAnswer } from "../answerers/schemas/index.js";
import type { CiWhen } from "../ci/index.js";
import type { SshTarget } from "../contracts/allocator.js";
import type { EventName, EventPayload } from "../events/index.js";
import type { EventStore } from "../eventStore.js";
import { createCodexAnswerer, createCodexWriter } from "../providers/codex.js";
import { SshCcusageAccountant, SshCodexbarUsageMonitor, SshUsageProbe, type UsageProbe } from "../usage/index.js";
import { type GateOutcome, resolveGateConfig, runGateForWhen } from "./gate/index.js";
import type { PlannerRunAdapterContext, RunPlannerLoopInput } from "./plannerRun.js";
import type { SubtaskLoopAdapters } from "./subtaskLoop.js";

export function defaultCodexAdapters(input: RunPlannerLoopInput, ctx: PlannerRunAdapterContext): SubtaskLoopAdapters {
  const credentialRef = input.context.codexCredentialRef;
  if (credentialRef === undefined || credentialRef === "") {
    throw new Error("codexCredentialRef is required to build the default Codex adapters");
  }
  // All four roles share one runId → one CODEX_HOME (codexHomeForRun), so
  // ccusage at run end accounts for the whole run and codexbar reads the run's
  // subscription account. The loop is sequential, so there is no concurrent
  // write to the shared home.
  const deps = {
    secrets: input.secrets,
    ssh: input.ssh,
    target: ctx.target,
    credentialRef,
    runId: ctx.runId,
  };
  return {
    planner: createCodexAnswerer<PlanAnswer>(deps),
    writer: createCodexWriter(deps),
    checker: createCodexAnswerer<CheckAnswer>(deps),
    auditor: createCodexAnswerer<AuditAnswer>(deps),
  };
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
