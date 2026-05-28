export type AgentKind = "writer" | "answerer";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface Commit {
  sha: string;
  message: string;
}

export interface WriterResult {
  diff: string;
  commits: Commit[];
  // `window_exhausted`: the provider authenticated successfully but the
  // subscription window / usage quota is spent (PROJECT_BRIEF §4.3). This is
  // an expected, recoverable condition — distinct from `crashed` — so the
  // workflow can escalate it as window pressure rather than a hard failure.
  exitReason: "completed" | "timeout" | "crashed" | "token_limit" | "window_exhausted";
  tokenUsage?: TokenUsage;
  telemetry?: {
    rawEventCount: number;
    tokenUsage?: TokenUsage;
    usageLimit?: UsageLimitSignal;
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
  readonly cli: "claude" | "codex" | "opencode" | "fake";
  // authRef is the credential reference that this adapter will use at call
  // time. The orchestrator reads it at task completion to attribute the
  // resulting cost record to one of the three v0 cost models (P2A-0011).
  // Adapters that do not consume an LLM (e.g. fake fixtures) still declare
  // an authRef so the CostRecorder can run uniformly.
  readonly authRef: string;
  runWriter(opts: { prompt: string; workspace: string; timeoutMs: number }): Promise<WriterResult>;
}

export interface AnswererRunOptions<TOutput> {
  prompt: string;
  timeoutMs: number;
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
  // See WriterAdapter.authRef: P2A-0011 attribution applies uniformly to
  // every real Codex planner/writer/checker/auditor call.
  readonly authRef: string;
  runAnswerer(opts: AnswererRunOptions<TOutput>): Promise<TOutput>;
}
