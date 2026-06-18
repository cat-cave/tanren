import type { RunnerHandle } from "../contracts/allocator.js";
import type {
  AccountingRead,
  SubscriptionWindow,
  UsageAccountant,
  UsageMonitor,
  UsageReadFailure,
  WindowUsage,
} from "./contracts.js";
import { DEFAULT_WINDOW_PRESSURE_THRESHOLD, evaluateWindowPressure } from "./pressure.js";

// A UsageProbe binds the two usage tools (codexbar window monitor + ccusage
// accountant) to ONE credential context — the provider/cli plus the per-run
// materialized CODEX_HOME and SSH target the run uses. The planner loop calls
// it without having to know how the tools are invoked (runner-side over SSH).
export interface WindowObservation {
  // The parsed window state, or null for a CLEAN-but-empty read (the tool ran,
  // no window data) — an allowed, quiet state. Null ALSO when `failure` is set,
  // but the two are DISCRIMINATED: `failure !== null` means the read FAILED
  // (loud), `failure === null` with `usage === null` means legitimate-empty.
  usage: WindowUsage | null;
  // The worst window at/over the pressure threshold, or null when every window
  // is below it (or there is no data / a read failure).
  pressure: SubscriptionWindow | null;
  // Non-null when the read FAILED (timeout / SSH / nonzero-exit / malformed) —
  // the loud signal the loop must NOT conflate with a zero-usage window.
  failure: UsageReadFailure | null;
}

export interface UsageProbe {
  // Pre-flight: read the live subscription-window state for this credential.
  observeWindow(): Promise<WindowObservation>;
  // Post-run: read token-consumption accounting for this credential. Returns the
  // DISCRIMINATED {@link AccountingRead} so a read failure is loud, never a
  // silent zero-token accounting.
  observeAccounting(): Promise<AccountingRead>;
}

export interface SshUsageProbeConfig {
  // The live subscription-window monitor (codexbar). OPTIONAL: a MANAGED
  // (OpenRouter-routed) run has NO ChatGPT subscription window — codex
  // authenticates as a plain OpenRouter API key, not an account, so codexbar
  // exits nonzero BY DESIGN ("codex account authentication required to read rate
  // limits"). There is genuinely no window to read, so a managed run wires NO
  // monitor and `observeWindow` returns a clean-empty read. This is NOT a silent
  // fallback: the window concept does not apply, so there is nothing to fail
  // loudly about. codexbar stays LOUD for a BYOK-subscription run where the
  // window DOES exist (a monitor IS wired) and a genuine read breaks.
  monitor?: UsageMonitor;
  accountant: UsageAccountant;
  provider: string;
  cli: string;
  codexHome: string;
  target: RunnerHandle;
  // 100 = escalate only when a window is fully consumed; lower to escalate
  // earlier (e.g. 90). Defaults to the shared pressure constant.
  pressureThresholdPercent?: number;
}

export class SshUsageProbe implements UsageProbe {
  constructor(private readonly config: SshUsageProbeConfig) {}

  async observeWindow(): Promise<WindowObservation> {
    // No window monitor wired (a MANAGED OpenRouter run has no subscription
    // window) → a clean-empty read, NOT a failure: there is nothing to probe.
    if (this.config.monitor === undefined) {
      return { usage: null, pressure: null, failure: null };
    }
    const read = await this.config.monitor.readWindowState({
      provider: this.config.provider,
      codexHome: this.config.codexHome,
      target: this.config.target,
    });
    // A read FAILURE is loud + distinct: no usage, no pressure, but `failure` set.
    if ("failed" in read) {
      return { usage: null, pressure: null, failure: read.failed };
    }
    const usage = read.ok;
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
            this.config.pressureThresholdPercent ?? DEFAULT_WINDOW_PRESSURE_THRESHOLD,
          );
    return { usage, pressure, failure: null };
  }

  async observeAccounting(): Promise<AccountingRead> {
    return this.config.accountant.readAccounting({
      cli: this.config.cli,
      codexHome: this.config.codexHome,
      target: this.config.target,
    });
  }
}

// Credits cover window overage, so a positive balance means a maxed window is
// not a blocker. A null balance (provider reports no credit pool) does NOT
// count as headroom — fall through to window-percent pressure.
function hasCreditHeadroom(usage: WindowUsage): boolean {
  return usage.creditsRemaining !== null && usage.creditsRemaining > 0;
}
