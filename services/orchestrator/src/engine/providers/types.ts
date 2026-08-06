import type { WatchdogProgressSignal } from "../contracts/commandSubstrate.js";
import type { JsonlObjectDecodeFailure } from "../contracts/jsonlDecodeFailure.js";

export type { JsonlObjectDecodeFailure, JsonlObjectParseFailure } from "../contracts/jsonlDecodeFailure.js";

// Token consumption by TYPE. Disjoint buckets — never fold into one number.
// All buckets are mutually exclusive and sum to totalTokens.
export interface TokenUsage {
  // uncached prompt tokens
  inputTokens: number;
  // cache-read tokens
  cachedInputTokens: number;
  // cache-write/creation (Anthropic; 0 for Codex)
  cacheCreationTokens: number;
  // non-reasoning completion tokens
  outputTokens: number;
  // reasoning tokens
  reasoningOutputTokens: number;
  // provider-reported total, else sum of the five
  totalTokens: number;
  // The provider's generation/response id, when the managed adapter surfaced one
  // (codex/claude/opencode response streams carry a top-level id when routed
  // THROUGH OpenRouter). Threaded to the cost recorder so a managed OpenRouter run
  // can post-call query `/api/v1/generation` for the REAL `usage.cost` and record
  // cost_usd as a metered FACT (`provider_response`). Absent on BYOK / non-managed
  // calls (no id surfaced) → cost_usd stays NULL/`unknown` (no list-rate estimate).
  openRouterGenerationId?: string;
}

// Zero-token usage with the full disjoint shape — used as the default when an
// adapter does not report usage (e.g. fake fixtures).
export const emptyTokenUsage: TokenUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};

export interface Commit {
  sha: string;
  message: string;
}

/**
 * The project's own commit gate rejected the writer's work.
 *
 * The writer adapters edit the workspace in place and Tanren commits afterwards
 * (`writerGit`/`codexGit`). That commit deliberately leaves the repository's hook
 * path LIVE, because it carries the writer's content into the PR — so the
 * project's `pre-commit` hook (lint / format / spell-check / typecheck) gets a
 * vote. When it votes NO, that is not an infrastructure fault: it is the target
 * repository telling us, precisely and reproducibly, what is wrong with the work
 * the writer just did. It is the SAME class of signal as a failed gate tier, and
 * it must reach the writer as steering rather than killing the run.
 *
 * `output` is the hook's own report — stdout AND stderr, bounded. Both streams
 * matter: lint/spell-check tooling routinely writes its findings to stdout and
 * only the "hook failed" epilogue to stderr, so a stderr-only capture would feed
 * the writer the epilogue and drop the actionable list of files/lines/words.
 */
export interface CommitRejection {
  /** The rejected workspace command's label (e.g. `commit codex workspace changes`). */
  label: string;
  /** The commit's exit code; `null` when the substrate reported none. */
  exitCode: number | null;
  /** Bounded combined stdout+stderr from the rejected commit — the hook's own report. */
  output: string;
}

export interface WriterResult {
  diff: string;
  commits: Commit[];
  // `window_exhausted`: the provider authenticated successfully but the
  // subscription window / usage quota is spent (PROJECT_BRIEF §4.3). This is
  // an expected, recoverable condition — distinct from `crashed` — so the
  // workflow can escalate it as window pressure rather than a hard failure.
  // `timeout`: the agent exec did not finish — the activity watchdog surfaced a
  // genuine absence of all signs of life (a recoverable stall), NOT a wall-clock
  // kill. (The name is the durable workflow/event classification for "did not
  // complete"; the SUBSTRATE-level no-progress flag is `CommandResult.stalled`.)
  // `commit_rejected`: the writer produced work and the PROJECT's commit hook
  // refused it. Recoverable and highly actionable — the loop re-drives the writer
  // with the hook's own output as steering, under the same convergence budget a
  // failed gate tier uses. Carries `commitRejection`.
  exitReason: "completed" | "timeout" | "crashed" | "token_limit" | "window_exhausted" | "commit_rejected";
  /**
   * Set iff `exitReason === "commit_rejected"` — the hook's verdict, for writer steering.
   *
   * "Iff" is load-bearing and is NOT free. The adapters capture git state — and therefore
   * the rejection — BEFORE they branch on stalled / usage-limit / nonzero-exit, so a writer
   * that stalled mid-edit and left a tree the hook then also refused has BOTH a rejection
   * and a `timeout`. Each adapter's `failedResult` therefore builds its result from an
   * EXPLICIT `{ diff, commits }` pick rather than `...gitState`, so a failure arm cannot
   * carry a rejection that does not describe it. Reintroducing the spread would restore the
   * leak SILENTLY: the wider captured object is structurally assignable to the narrower
   * parameter type, so the compiler says nothing. (#1420 review.)
   */
  commitRejection?: CommitRejection;
  tokenUsage?: TokenUsage;
  telemetry?: {
    rawEventCount: number;
    tokenUsage?: TokenUsage;
    usageLimit?: UsageLimitSignal;
    jsonlDecodeFailure?: JsonlObjectDecodeFailure;
  };
}

// UsageLimitSignal is parsed from the Codex JSONL `turn.failed` / `error`
// event when the account hits its usage limit. Carries the provider's
// human-readable message (which usually names the reset time) so the
// operator gets an actionable signal instead of a generic crash.
export interface UsageLimitSignal {
  message: string;
}

export interface WriterAdapter {
  readonly kind: "writer";
  readonly cli: "claude" | "codex" | "opencode" | "aider" | "pi" | "reasonix" | "fake";
  // authRef is the credential reference that this adapter will use at call
  // time. The orchestrator reads it at task completion to attribute the
  // resulting cost record to one of the three v0 cost models.
  // Adapters that do not consume an LLM (e.g. fake fixtures) still declare
  // an authRef so the CostRecorder can run uniformly.
  readonly authRef: string;
  // `baseSha` is the run's BASE commit (the clone point / base-branch tip),
  // captured once after the workspace clone. When provided, the adapter diffs
  // the workspace against it so each subtask is judged against the CUMULATIVE
  // state vs the run base — not the per-subtask HEAD delta. This makes a
  // no-op-but-already-satisfied subtask (e.g. a replanned "create FILE" whose
  // work a prior subtask already committed) still show the file in its diff, so
  // the checker passes instead of false-rejecting an empty per-iteration delta.
  // The production run path always threads it; fake test adapters ignore it.
  //
  // `onWatchdogProgress` is the CROSS-LAYER sign-of-life bridge (task #24, apex
  // v52/v53): each writer adapter forwards it to `buildActivityWatchdog` so the
  // substrate invokes it on every probe tick the work signature advances. The
  // writerStage binds a closure that emits `writer.subtask.progress` — a durable
  // per-tick advancement signal any parent progress reader can observe. Composes
  // with the substrate-internal `MIN_NON_ADVANCING_NEIGHBOR_REPEATS_*` streak floor
  // (ssh/watchdogProgress.ts) — a wedge fires only after N consecutive
  // identical-neighbor probe pairs, so a legitimately slow writer (a `pnpm install`
  // window) whose signature briefly plateaus does not trip a spurious wedge.
  // Optional; fake test adapters ignore it.
  runWriter(opts: {
    prompt: string;
    workspace: string;
    baseSha?: string;
    onWatchdogProgress?: (signal: WatchdogProgressSignal) => void;
  }): Promise<WriterResult>;
}

export interface AnswererRunOptions<TOutput> {
  prompt: string;
  workspace?: string;
  outputSchema: {
    name: string;
    jsonSchema: Record<string, unknown>;
    parse(value: unknown): TOutput;
  };
}

export interface AnswererAdapter<TOutput> {
  readonly kind: "answerer";
  readonly cli: "claude" | "codex" | "fake";
  // See WriterAdapter.authRef: attribution applies uniformly to
  // every real Codex planner/writer/checker/auditor call.
  readonly authRef: string;
  runAnswerer(opts: AnswererRunOptions<TOutput>): Promise<TOutput>;
  // The token telemetry parsed from the MOST RECENT runAnswerer call's harness
  // output (codex/claude emit per-call usage in their JSONL/stream-json events),
  // or undefined when the call surfaced none. The cost path reads this right
  // after the awaited call (same adapter instance) to record the REAL per-call
  // TokenUsage — so notional cost is computed from actual tokens (LiteLLM rates)
  // INDEPENDENT of the separate codexbar/ccusage window probe. Absent on a `fake`
  // fixture (legitimately zero-token). A real call that returns undefined here is
  // genuine token-telemetry breakage → the loud `usage.token_accounting_failed`.
  lastTokenUsage?(): TokenUsage | undefined;
}
