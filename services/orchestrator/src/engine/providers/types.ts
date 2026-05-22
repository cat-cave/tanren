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
  exitReason: "completed" | "timeout" | "crashed" | "token_limit";
  tokenUsage?: TokenUsage;
  telemetry?: {
    rawEventCount: number;
    tokenUsage?: TokenUsage;
  };
}

export interface WriterAdapter {
  readonly kind: "writer";
  readonly cli: "claude" | "codex" | "opencode" | "fake";
  runWriter(opts: { prompt: string; workspace: string; timeoutMs: number }): Promise<WriterResult>;
}

export interface AnswererAdapter<TOutput> {
  readonly kind: "answerer";
  readonly cli: "claude" | "codex" | "fake";
  runAnswerer(opts: { prompt: string; timeoutMs: number }): Promise<TOutput>;
}
