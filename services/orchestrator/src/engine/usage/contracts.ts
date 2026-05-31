import type { SshTarget } from "../contracts/allocator.js";
import type { TokenUsage } from "../providers/types.js";

// Usage monitoring is split across two tools, each with a distinct job:
//
//   codexbar  — LIVE subscription-window / quota state. Reports one or more
//               concurrent rolling windows (primary/secondary/tertiary) as a
//               percent-of-window consumed + reset time. There is NO token
//               denominator — these are server-enforced windows, not budgets.
//               CLI/provider-agnostic; honors CODEX_HOME.
//
//   ccusage   — token-consumption ACCOUNTING across coding CLIs. Reads the
//               CLI's local session logs (honors CODEX_HOME) and reports
//               disjoint token buckets plus a best-effort costUSD. For a
//               subscription it usually reports costUSD 0 (no real dollar
//               figure); only a positive figure becomes a cost.
//
// Both run in the runner over the SSH substrate against the per-run
// materialized CODEX_HOME — the orchestrator engine never spawns host
// processes (the no-host-process-spawn architecture rule).

// One concurrent rolling subscription window as reported by codexbar.
export interface SubscriptionWindow {
  slot: "primary" | "secondary" | "tertiary";
  usedPercent: number;
  // ISO
  resetsAt: string;
  windowMinutes: number;
  resetDescription: string;
}

// The live subscription-window state for one provider/account.
export interface WindowUsage {
  provider: string;
  // only non-null slots
  windows: SubscriptionWindow[];
  creditsRemaining: number | null;
  accountEmail: string | null;
  // e.g. "codex-cli"
  source: string;
  capturedAt: string;
}

export interface UsageMonitor {
  // Runs codexbar in the runner over SSH against codexHome. Returns null when
  // the tool has no data for the provider (not an error).
  readWindowState(input: {
    provider: string;
    codexHome: string;
    target: SshTarget;
    timeoutMs: number;
  }): Promise<WindowUsage | null>;
}

export interface CcusageModelUsage {
  model: string;
  usage: TokenUsage;
}

export interface CcusageAccounting {
  cli: string;
  // reuse the disjoint TokenUsage
  totals: TokenUsage;
  // ccusage costUSD; null if ccusage reports 0/none for a subscription
  costUsd: number | null;
  perModel: CcusageModelUsage[];
  capturedAt: string;
}

export interface UsageAccountant {
  // Runs `ccusage <cli> --json` in the runner over SSH against codexHome.
  readAccounting(input: {
    cli: string;
    codexHome: string;
    target: SshTarget;
    timeoutMs: number;
  }): Promise<CcusageAccounting | null>;
}
