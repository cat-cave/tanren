// plannerRunUsage — the run's CODEX-specific usage/cost builders, split out of
// plannerRunAdapters to keep that file under the 500-line architecture cap. Both
// are codex-subscription-specific: the managed real-cost capturer and the
// ccusage/codexbar usage probe. The probe's per-role gating (build it when ANY
// role is codex) lives in plannerRunAdapters' resolveRunAdaptersWithBudgetPreflight.

import { SshCcusageAccountant, SshCodexbarUsageMonitor, SshUsageProbe, type UsageProbe } from "../usage/index.js";
import { buildManagedGenerationCostCapturer, type RealProviderCostCapturer } from "../costs/generationCostCapture.js";
import type { PlannerRunAdapterContext, RunPlannerLoopInput } from "./plannerRun.js";

// Builds the MANAGED-run real-cost capturer (resolves the platform OpenRouter key
// once and returns a per-call `usage.cost` query). A managed run is identified by
// the resolved `endpointBaseUrl` (the OpenAI-compatible managed endpoint) + the
// platform credential ref (`defaultLlm.authRef`, which under managed mode IS the
// platform OpenRouter ref). A BYOK / non-managed run sets no `endpointBaseUrl`, so
// this returns undefined and cost_usd is left a metered FACT-or-NULL (no estimate).
export async function buildManagedCapturerForRun(
  input: RunPlannerLoopInput,
): Promise<RealProviderCostCapturer | undefined> {
  const endpointBaseUrl = input.context.endpointBaseUrl;
  // No managed endpoint ⇒ BYOK run, no managed capturer (cost stays metered FACT-or-NULL).
  if (endpointBaseUrl === undefined) {
    return undefined;
  }
  // A managed run (endpoint set) MUST carry a resolved default LLM authRef (the
  // platform credential ref). Missing it is a wiring bug — fail loud, never
  // quiet-degrade managed accounting to none.
  const managedCredentialRef = input.context.defaultLlm?.authRef;
  if (managedCredentialRef === undefined || managedCredentialRef.trim() === "") {
    throw new Error("managed run has an endpoint override but no resolved defaultLlm authRef — a wiring bug");
  }
  return buildManagedGenerationCostCapturer({
    secrets: input.secrets,
    managedCredentialRef,
    endpointBaseUrl,
  });
}

// The default CODEX usage probe: the ccusage accountant + codexbar window monitor
// over the run's shared CODEX_HOME. Built only when the run uses codex (gated by
// the caller) — provider/cli are codex-specific.
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
