// plannerRunUsage — the run's CODEX-specific usage/cost builders, split out of
// plannerRunAdapters to keep that file under the 500-line architecture cap. Both
// are codex-subscription-specific: the managed real-cost capturer and the
// ccusage/codexbar usage probe. The probe's per-role gating (build it when ANY
// role is codex) lives in plannerRunAdapters' resolveRunAdaptersWithBudgetPreflight.

import { SshCcusageAccountant, SshCodexbarUsageMonitor, SshUsageProbe, type UsageProbe } from "../usage/index.js";
import { buildManagedGenerationCostCapturer, type RealProviderCostCapturer } from "../costs/generationCostCapture.js";
import type { AppendEvent } from "./subtaskLoop.js";
import type { PlannerRunAdapterContext, RunPlannerLoopInput } from "./plannerRun.js";

// The DISCRIMINATED outcome of the managed real-cost capturer resolution. A
// MANAGED run builds the `capturer` (it queries the per-call `usage.cost`); a
// BYOK run has NO platform metering credential — that capture is a managed-only
// step with no BYOK analog, so it is EXPLICITLY skipped (`skipped`), NOT a silent
// undefined and NEVER an empty platform ref pushed through the validator. The
// caller narrates the skip loudly (`cost.managed_metering_skipped`).
export type ManagedCapturerResolution =
  | { capturer: RealProviderCostCapturer }
  | { capturer: undefined; skipped: "byok_no_platform_metering_ref" };

// Resolves the MANAGED-run real-cost capturer (or the explicit BYOK skip). A
// managed run is identified by the resolved `endpointBaseUrl` (the OpenAI-
// compatible managed endpoint) + the platform credential ref (`defaultLlm.authRef`,
// which under managed mode IS the platform OpenRouter ref). A BYOK / non-managed
// run sets no `endpointBaseUrl`, so there is no platform metering key — the
// per-call real-cost query is a MANAGED-ONLY step: we return the EXPLICIT
// `skipped` discriminant (cost stays a metered FACT-or-NULL from the BYOK
// credential's own ledger), rather than touching a platform ref that does not
// exist in BYOK (the apex v30 empty-ref class of crash).
export async function buildManagedCapturerForRun(input: RunPlannerLoopInput): Promise<ManagedCapturerResolution> {
  const endpointBaseUrl = input.context.endpointBaseUrl;
  // No managed endpoint ⇒ BYOK run. There is NO platform metering credential to
  // query — the per-call real-cost capture has no BYOK analog. Skip it EXPLICITLY
  // (the caller narrates it); cost stays metered FACT-or-NULL, no empty ref.
  if (endpointBaseUrl === undefined) {
    return { capturer: undefined, skipped: "byok_no_platform_metering_ref" };
  }
  // A managed run (endpoint set) MUST carry a resolved default LLM authRef (the
  // platform credential ref). Missing it is a wiring bug — fail loud, never
  // quiet-degrade managed accounting to none.
  const managedCredentialRef = input.context.defaultLlm?.authRef;
  if (managedCredentialRef === undefined || managedCredentialRef.trim() === "") {
    throw new Error("managed run has an endpoint override but no resolved defaultLlm authRef — a wiring bug");
  }
  return {
    capturer: await buildManagedGenerationCostCapturer({
      secrets: input.secrets,
      managedCredentialRef,
      endpointBaseUrl,
    }),
  };
}

// Resolve the run's per-call real-cost capturer AND narrate the BYOK skip. A
// MANAGED run returns the capturer; a BYOK run returns undefined AND emits the
// LOUD, intentional `cost.managed_metering_skipped` (no platform metering ref in
// BYOK — explicit "no analog" branch, never an empty ref through the validator).
export async function resolveManagedCapturer(
  input: RunPlannerLoopInput,
  appendEvent: AppendEvent,
): Promise<RealProviderCostCapturer | undefined> {
  const resolution = await buildManagedCapturerForRun(input);
  if (resolution.capturer === undefined) {
    await appendEvent("cost.managed_metering_skipped", {
      providerMode: "byok",
      reason:
        "BYOK run has no platform metering credential, so the managed-only per-call real-cost query is skipped; real spend stays a metered FACT-or-NULL from the BYOK credential's own ledger (ccusage / credit drawdown)",
    });
  }
  return resolution.capturer;
}

// The default CODEX usage probe: the ccusage accountant + (BYOK only) codexbar
// window monitor over the run's shared CODEX_HOME. Built only when the run uses
// codex (gated by the caller) — provider/cli are codex-specific.
//
// The codexbar WINDOW monitor reads the codex ChatGPT-account subscription
// window, which only EXISTS on a BYOK-subscription run (an account auth.json in
// CODEX_HOME). A MANAGED run routes codex THROUGH OpenRouter as a plain API key
// — there is no account window, so codexbar exits nonzero by design ("codex
// account authentication required to read rate limits"). Wiring it there would
// fire a SPURIOUS `usage.read_failed` every preflight. So the monitor is wired
// ONLY for a BYOK (non-managed) run; a managed run omits it (clean-empty window
// read). ccusage — the TOKEN accountant feeding notional cost — is ALWAYS wired:
// it reads the per-run CODEX_HOME session logs and works in BOTH modes.
export function defaultUsageProbe(input: RunPlannerLoopInput, ctx: PlannerRunAdapterContext): UsageProbe {
  const managed = input.context.endpointBaseUrl !== undefined;
  return new SshUsageProbe({
    ...(managed ? {} : { monitor: new SshCodexbarUsageMonitor(input.ssh) }),
    accountant: new SshCcusageAccountant(input.ssh),
    provider: "codex",
    cli: "codex",
    codexHome: ctx.codexHome,
    target: ctx.target,
    timeoutMs: input.timeoutMs,
    pressureThresholdPercent: input.pressureThresholdPercent,
  });
}
