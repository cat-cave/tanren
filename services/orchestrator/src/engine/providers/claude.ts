import type { SshTarget } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { SshSubstrate } from "../contracts/sshSubstrate.js";
import { storeClaudeAuthBundle } from "../credentials/claudeAuth.js";
import { materializeClaudeAuthBundle } from "../credentials/claudeMaterializer.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { AnswererSchemaValidationError } from "./codex.js";
import type { AnswererAdapter, TokenUsage, UsageLimitSignal, WriterAdapter, WriterResult } from "./types.js";
import { captureBaselineSha, captureGitStateAfterWriter } from "./writerGit.js";

// P3-0012: Claude CLI Writer + Answerer adapters. They mirror the Codex adapter
// contracts (same WriterAdapter/AnswererAdapter shapes, same SSH-execution +
// credential-ref materialization) but invoke the `claude` CLI. The Claude CLI
// streams JSON events on stdout (`--output-format stream-json`), so token usage
// and usage-limit signals are parsed from that stream the same way Codex parses
// its JSONL.

export interface ClaudeWriterDependencies {
  secrets: SecretStore;
  ssh: SshSubstrate;
  target: SshTarget;
  credentialRef: string;
  runId: string;
  // The Claude model id this adapter pins (e.g. the routing chain entry's
  // `model`). Defaults to the CLI's configured default when omitted.
  model?: string;
  claudeHomeBaseDir?: string;
  // SaaS Tier-B #5: optional managed-endpoint base URL. When set (managed run),
  // the CLI is pointed at this OpenAI/Anthropic-compatible endpoint (the
  // platform OpenRouter shell) via ANTHROPIC_BASE_URL. Absent ⇒ BYOK: no
  // override, the CLI hits Anthropic directly (unchanged).
  endpointBaseUrl?: string;
}

export interface ClaudeAnswererDependencies extends ClaudeWriterDependencies {
  answererWorkspaceBaseDir?: string;
}

export interface ClaudeEventTelemetry {
  rawEventCount: number;
  tokenUsage?: TokenUsage;
  usageLimit?: UsageLimitSignal;
}

// Raised by the Answerer path when Claude authenticated but the account's usage
// limit / subscription window is exhausted. Mirrors CodexUsageLimitError so the
// workflow escalates window pressure (PROJECT_BRIEF §4.3) rather than a crash.
export class ClaudeUsageLimitError extends Error {
  constructor(
    readonly schemaName: string,
    readonly providerMessage: string,
  ) {
    super(`Claude usage limit reached for schema ${schemaName}: ${providerMessage}`);
    this.name = "ClaudeUsageLimitError";
  }
}

export function createClaudeWriter(dependencies: ClaudeWriterDependencies): WriterAdapter {
  return {
    kind: "writer",
    cli: "claude",
    authRef: dependencies.credentialRef,
    async runWriter(opts): Promise<WriterResult> {
      const auth = await materializeClaudeAuthBundle({
        secrets: dependencies.secrets,
        ssh: dependencies.ssh,
        target: dependencies.target,
        ref: dependencies.credentialRef,
        runId: dependencies.runId,
        baseDir: dependencies.claudeHomeBaseDir,
        timeoutMs: Math.min(opts.timeoutMs, 30_000),
      });
      const baselineSha = await captureBaselineSha(
        dependencies.ssh,
        dependencies.target,
        opts.workspace,
        opts.timeoutMs,
      );
      const claude = await dependencies.ssh.run(dependencies.target, {
        command: buildClaudeWriterCommand({
          configDir: auth.CLAUDE_CONFIG_DIR,
          workspace: opts.workspace,
          model: dependencies.model,
          endpointBaseUrl: dependencies.endpointBaseUrl,
        }),
        stdin: opts.prompt,
        timeoutMs: opts.timeoutMs,
      });
      const telemetry = parseClaudeStreamTelemetry(claude.stdout);
      const gitState = await captureGitStateAfterWriter(
        dependencies.ssh,
        dependencies.target,
        opts.workspace,
        baselineSha,
        "claude writer",
        opts.timeoutMs,
      );
      if (claude.timedOut) {
        return failedResult("timeout", telemetry, gitState);
      }
      if (telemetry.usageLimit !== undefined) {
        return failedResult("window_exhausted", telemetry, gitState);
      }
      if (claude.failure !== undefined || claude.exitCode !== 0) {
        return failedResult("crashed", telemetry, gitState);
      }
      return { ...gitState, exitReason: "completed", tokenUsage: telemetry.tokenUsage, telemetry };
    },
  };
}

export function createClaudeAnswerer<TOutput>(dependencies: ClaudeAnswererDependencies): AnswererAdapter<TOutput> {
  return {
    kind: "answerer",
    cli: "claude",
    authRef: dependencies.credentialRef,
    async runAnswerer(opts): Promise<TOutput> {
      const auth = await materializeClaudeAuthBundle({
        secrets: dependencies.secrets,
        ssh: dependencies.ssh,
        target: dependencies.target,
        ref: dependencies.credentialRef,
        runId: dependencies.runId,
        baseDir: dependencies.claudeHomeBaseDir,
        timeoutMs: Math.min(opts.timeoutMs, 30_000),
      });
      const workspace = opts.workspace ?? answererWorkspacePath(dependencies, opts.outputSchema.name);
      await dependencies.ssh.run(dependencies.target, {
        command: `mkdir -p ${quoteSshShellArg(workspace)}`,
        timeoutMs: Math.min(opts.timeoutMs, 30_000),
      });
      const result = await dependencies.ssh.run(dependencies.target, {
        command: buildClaudeAnswererCommand({
          configDir: auth.CLAUDE_CONFIG_DIR,
          workspace,
          model: dependencies.model,
          endpointBaseUrl: dependencies.endpointBaseUrl,
        }),
        stdin: buildAnswererPrompt(opts.prompt, opts.outputSchema.name, opts.outputSchema.jsonSchema),
        timeoutMs: opts.timeoutMs,
      });
      const telemetry = parseClaudeStreamTelemetry(result.stdout);
      if (result.timedOut) {
        throw new Error(`Claude Answerer timed out for schema ${opts.outputSchema.name}`);
      }
      if (telemetry.usageLimit !== undefined) {
        throw new ClaudeUsageLimitError(opts.outputSchema.name, telemetry.usageLimit.message);
      }
      if (result.failure !== undefined || result.exitCode !== 0) {
        throw new Error(
          `Claude Answerer failed for schema ${opts.outputSchema.name}: exit ${result.exitCode ?? "unknown"}`,
        );
      }
      const text = extractClaudeFinalText(result.stdout);
      return parseClaudeAnswererOutput(text, opts.outputSchema);
    },
  };
}

// The Claude CLI accepts the prompt on stdin and emits a stream of JSON events
// on stdout. Writer mode runs with permission to edit the workspace; we pin the
// working directory with --add-dir and read the prompt from stdin via `-p -`.
export function buildClaudeWriterCommand(input: {
  configDir: string;
  workspace: string;
  model?: string;
  endpointBaseUrl?: string;
}): string {
  return [
    `CLAUDE_CONFIG_DIR=${quoteSshShellArg(input.configDir)}`,
    ...claudeEndpointEnv(input.endpointBaseUrl),
    "claude",
    "-p",
    "--output-format stream-json",
    "--verbose",
    "--permission-mode acceptEdits",
    "--add-dir",
    quoteSshShellArg(input.workspace),
    ...modelFlag(input.model),
  ].join(" ");
}

// SaaS Tier-B #5: the managed-endpoint env override the Claude CLI reads. When
// a managed run resolves the platform endpoint, we set ANTHROPIC_BASE_URL so the
// CLI's API calls go to the platform OpenRouter shell with the platform key.
// BYOK ⇒ no override (empty prefix), the CLI hits Anthropic directly.
function claudeEndpointEnv(endpointBaseUrl?: string): string[] {
  return endpointBaseUrl === undefined ? [] : [`ANTHROPIC_BASE_URL=${quoteSshShellArg(endpointBaseUrl)}`];
}

// Answerer mode is read-only: no edit permission, no workspace mutation. The
// structured-output contract is enforced by us (prompt asks for JSON-only,
// matching the schema) since the Claude CLI has no --output-schema flag.
export function buildClaudeAnswererCommand(input: {
  configDir: string;
  workspace: string;
  model?: string;
  endpointBaseUrl?: string;
}): string {
  return [
    `CLAUDE_CONFIG_DIR=${quoteSshShellArg(input.configDir)}`,
    ...claudeEndpointEnv(input.endpointBaseUrl),
    "claude",
    "-p",
    "--output-format stream-json",
    "--verbose",
    "--permission-mode plan",
    "--add-dir",
    quoteSshShellArg(input.workspace),
    ...modelFlag(input.model),
  ].join(" ");
}

function modelFlag(model?: string): string[] {
  return model === undefined || model === "" ? [] : ["--model", quoteSshShellArg(model)];
}

export function buildAnswererPrompt(prompt: string, schemaName: string, jsonSchema: Record<string, unknown>): string {
  return [
    prompt,
    "",
    `Respond with ONLY a single JSON object that validates against the "${schemaName}" JSON Schema below.`,
    "Do not wrap it in markdown fences or add any prose before or after the JSON.",
    "JSON Schema:",
    JSON.stringify(jsonSchema),
  ].join("\n");
}

// Parses the Claude CLI `stream-json` output: one JSON object per line. Token
// usage lives on `result`/`assistant` events under a `usage` object; a
// usage-limit error surfaces as an `error`/`result` event carrying the stable
// "usage limit" phrase (matched on the phrase, not the event type).
export function parseClaudeStreamTelemetry(stdout: string): ClaudeEventTelemetry {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
  let tokenUsage: TokenUsage | undefined;
  let usageLimit: UsageLimitSignal | undefined;
  for (const line of lines) {
    const parsed = parseJsonObject(line);
    if (parsed === undefined) {
      continue;
    }
    tokenUsage = findTokenUsage(parsed) ?? tokenUsage;
    usageLimit = detectUsageLimit(parsed) ?? usageLimit;
  }
  return { rawEventCount: lines.length, tokenUsage, usageLimit };
}

// Pulls the final assistant message text out of the stream-json events. Claude
// emits a terminal `{"type":"result","result":"<text>"}`; we fall back to the
// last assistant text block if the result envelope is absent.
export function extractClaudeFinalText(stdout: string): string {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
  let lastAssistantText: string | undefined;
  for (const line of lines) {
    const parsed = parseJsonObject(line);
    if (parsed === undefined) {
      continue;
    }
    if (parsed["type"] === "result" && typeof parsed["result"] === "string") {
      return parsed["result"];
    }
    const assistantText = assistantTextFromEvent(parsed);
    if (assistantText !== undefined) {
      lastAssistantText = assistantText;
    }
  }
  return lastAssistantText ?? "";
}

function assistantTextFromEvent(event: Record<string, unknown>): string | undefined {
  if (event["type"] !== "assistant") {
    return undefined;
  }
  const message = event["message"];
  if (typeof message !== "object" || message === null) {
    return undefined;
  }
  const content = (message as Record<string, unknown>)["content"];
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .map((block) =>
      typeof block === "object" && block !== null ? (block as Record<string, unknown>)["text"] : undefined,
    )
    .filter((value): value is string => typeof value === "string")
    .join("");
  return text === "" ? undefined : text;
}

export function parseClaudeAnswererOutput<TOutput>(
  text: string,
  schema: { name: string; parse(value: unknown): TOutput },
): TOutput {
  const trimmed = stripJsonFences(text).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new AnswererSchemaValidationError(schema.name, `invalid JSON: ${messageFromUnknown(error)}`);
  }
  try {
    return schema.parse(parsed);
  } catch (error) {
    throw new AnswererSchemaValidationError(schema.name, messageFromUnknown(error));
  }
}

function stripJsonFences(text: string): string {
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(text.trim());
  return fence?.[1] ?? text;
}

// detectUsageLimit recognizes the events the Claude CLI emits on a usage-limit
// rejection. Matched on the stable "usage limit" phrase so a minor wording
// change in the error envelope still surfaces it.
function detectUsageLimit(event: Record<string, unknown>): UsageLimitSignal | undefined {
  const candidates: unknown[] = [event["message"], event["result"], event["error"]];
  const errorField = event["error"];
  if (typeof errorField === "object" && errorField !== null && !Array.isArray(errorField)) {
    candidates.push((errorField as Record<string, unknown>)["message"]);
  }
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /usage limit/i.test(candidate)) {
      return { message: candidate };
    }
  }
  return undefined;
}

function findTokenUsage(value: unknown): TokenUsage | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const usage = tokenUsageFromRecord(record);
  if (usage !== undefined) {
    return usage;
  }
  for (const child of Object.values(record)) {
    const nested = findTokenUsage(child);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

// Claude usage shape is already DISJOINT: input_tokens excludes cache tokens,
// cache_read_input_tokens and cache_creation_input_tokens are separate buckets,
// and output_tokens has no reasoning sub-bucket on the CLI. So we map straight
// across with no de-overlap (unlike the Codex inclusive shape).
function tokenUsageFromRecord(record: Record<string, unknown>): TokenUsage | undefined {
  const inputTokens = numberField(record, ["input_tokens", "inputTokens"]);
  const outputTokens = numberField(record, ["output_tokens", "outputTokens"]);
  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined;
  }
  const cachedInputTokens = numberField(record, ["cache_read_input_tokens", "cachedInputTokens"]) ?? 0;
  const cacheCreationTokens = numberField(record, ["cache_creation_input_tokens", "cacheCreationTokens"]) ?? 0;
  const reasoningOutputTokens = numberField(record, ["reasoning_output_tokens", "reasoningOutputTokens"]) ?? 0;
  const totalTokens =
    numberField(record, ["total_tokens", "totalTokens"]) ??
    inputTokens + cachedInputTokens + cacheCreationTokens + outputTokens + reasoningOutputTokens;
  return {
    inputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  };
}

function numberField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function parseJsonObject(line: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function answererWorkspacePath(dependencies: ClaudeAnswererDependencies, schemaName: string): string {
  const baseDir = dependencies.answererWorkspaceBaseDir ?? "/tmp/tanren-answerer-runs";
  return `${baseDir}/${dependencies.runId}/${safeSchemaFileName(schemaName)}`;
}

function safeSchemaFileName(schemaName: string): string {
  return schemaName.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failedResult(
  exitReason: "timeout" | "crashed" | "window_exhausted",
  telemetry: ClaudeEventTelemetry,
  gitState: Pick<WriterResult, "diff" | "commits">,
): WriterResult {
  return { ...gitState, exitReason, tokenUsage: telemetry.tokenUsage, telemetry };
}

// Re-export so callers can persist a refreshed Claude auth bundle the same way
// the Codex path does (best-effort write-back lives in the registry/workflow).
export { storeClaudeAuthBundle };
