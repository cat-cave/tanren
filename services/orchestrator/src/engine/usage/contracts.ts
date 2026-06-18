import type { RunnerHandle } from "../contracts/allocator.js";
import type { CostResolver } from "../contracts/costResolver.js";
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

// Why a usage read FAILED, distinct from "the tool ran clean but had no data".
// A timeout / SSH transport failure / non-zero exit / malformed non-empty output
// is a LOUD read failure (`usage.read_failed`): the tool could NOT report, which
// must NEVER be conflated with a legitimate zero-usage window. `detail` is a
// secret-free diagnostic (a stderr / stdout tail), `exitCode` the process exit.
export interface UsageReadFailure {
  // Which probe tool failed.
  tool: "codexbar" | "ccusage";
  // The provider / cli the read was for (secret-free label).
  target: string;
  // The failure class.
  reason: "timeout" | "ssh_failure" | "nonzero_exit" | "malformed_output";
  // The process exit code when known (null for a transport-level failure).
  exitCode: number | null;
  // A secret-free diagnostic tail (stderr for a transport failure, a stdout tail
  // for malformed output) so an operator can tell the cause apart.
  detail: string;
}

// A DISCRIMINATED window read. `ok` carries the parsed state OR null when the
// tool ran clean but genuinely had no window data (an allowed, quiet state);
// `failed` carries a loud {@link UsageReadFailure}. The two are NEVER conflated:
// a read failure must not silently become "no window pressure".
export type WindowRead = { ok: WindowUsage | null } | { failed: UsageReadFailure };

// A DISCRIMINATED accounting read. `ok` carries the parsed accounting OR null
// when ccusage ran clean but had no data; `failed` carries a loud read failure.
export type AccountingRead = { ok: CcusageAccounting | null } | { failed: UsageReadFailure };

export interface UsageMonitor {
  // Runs codexbar in the runner over SSH against codexHome. Returns a
  // DISCRIMINATED {@link WindowRead}: `{ ok }` (parsed state, or null for a
  // clean-but-empty read) vs `{ failed }` for a timeout / SSH / nonzero-exit /
  // malformed-output read failure — the failure is loud, never a silent "no data".
  readWindowState(input: { provider: string; codexHome: string; target: RunnerHandle }): Promise<WindowRead>;
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
  // Returns a DISCRIMINATED {@link AccountingRead}: `{ ok }` (parsed, or null
  // for a clean-but-empty read) vs `{ failed }` for a loud read failure.
  readAccounting(input: { cli: string; codexHome: string; target: RunnerHandle }): Promise<AccountingRead>;
}

// THE USAGE METER seam — the single named contract over the three usage reads a
// run draws on: the live subscription-window state ({@link UsageMonitor}), the
// token-consumption accounting ({@link UsageAccountant}), and the per-call dollar
// resolution ({@link CostResolver}, in engine/contracts/costResolver.ts). It does
// NOT replace those three seams (each stays independently slottable) — it NAMES
// the unified surface so a consumer asks one thing for "what did this credential
// consume + cost" instead of wiring three references. The cost-as-fact semantics
// are preserved end-to-end: a dollar figure is the metered FACT or null, never a
// hardcoded estimate. A backend with a native metering API satisfies this seam
// by supplying the three members.
export interface UsageMeter {
  monitor: UsageMonitor;
  accountant: UsageAccountant;
  costResolver: CostResolver;
}
