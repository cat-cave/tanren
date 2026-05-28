import type { SshTarget } from "../contracts/allocator.js";
import type { CcusageAccounting, SubscriptionWindow, UsageAccountant, UsageMonitor, WindowUsage } from "./contracts.js";
import { DEFAULT_WINDOW_PRESSURE_THRESHOLD, evaluateWindowPressure } from "./pressure.js";

// A UsageProbe binds the two usage tools (codexbar window monitor + ccusage
// accountant) to ONE credential context — the provider/cli plus the per-run
// materialized CODEX_HOME and SSH target the run uses. The planner loop calls
// it without having to know how the tools are invoked (runner-side over SSH).
export interface WindowObservation {
  // Null when the tool returned no data (not an error) — an allowed state.
  usage: WindowUsage | null;
  // The worst window at/over the pressure threshold, or null when every
  // window is below it (or there is no data). When non-null the loop should
  // escalate window pressure instead of dispatching a doomed call.
  pressure: SubscriptionWindow | null;
}

export interface UsageProbe {
  // Pre-flight: read the live subscription-window state for this credential.
  observeWindow(): Promise<WindowObservation>;
  // Post-run: read token-consumption accounting for this credential.
  observeAccounting(): Promise<CcusageAccounting | null>;
}

export interface SshUsageProbeConfig {
  monitor: UsageMonitor;
  accountant: UsageAccountant;
  provider: string;
  cli: string;
  codexHome: string;
  target: SshTarget;
  timeoutMs: number;
  // 100 = escalate only when a window is fully consumed; lower to escalate
  // earlier (e.g. 90). Defaults to the shared pressure constant.
  pressureThresholdPercent?: number;
}

export class SshUsageProbe implements UsageProbe {
  constructor(private readonly config: SshUsageProbeConfig) {}

  async observeWindow(): Promise<WindowObservation> {
    const usage = await this.config.monitor.readWindowState({
      provider: this.config.provider,
      codexHome: this.config.codexHome,
      target: this.config.target,
      timeoutMs: this.config.timeoutMs
    });
    // Window pressure is credit-aware: a maxed subscription window is NOT a
    // doomed call when prepaid credits are available, because overage draws
    // those credits (verified live — Codex Pro runs against credits with the
    // weekly window at 100%). Only escalate window pressure when there is no
    // credit headroom (creditsRemaining is null or 0). If credits run out
    // mid-run the call surfaces a usage-limit error, which the loop handles.
    const pressure =
      usage === null || hasCreditHeadroom(usage)
        ? null
        : evaluateWindowPressure(
            usage.windows,
            this.config.pressureThresholdPercent ?? DEFAULT_WINDOW_PRESSURE_THRESHOLD
          );
    return { usage, pressure };
  }

  async observeAccounting(): Promise<CcusageAccounting | null> {
    return this.config.accountant.readAccounting({
      cli: this.config.cli,
      codexHome: this.config.codexHome,
      target: this.config.target,
      timeoutMs: this.config.timeoutMs
    });
  }
}

// Credits cover window overage, so a positive balance means a maxed window is
// not a blocker. A null balance (provider reports no credit pool) does NOT
// count as headroom — fall through to window-percent pressure.
function hasCreditHeadroom(usage: WindowUsage): boolean {
  return usage.creditsRemaining !== null && usage.creditsRemaining > 0;
}
