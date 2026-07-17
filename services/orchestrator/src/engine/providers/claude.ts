import type { RunnerHandle } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { CommandResult, CommandSubstrate } from "../contracts/commandSubstrate.js";
import { storeClaudeAuthBundle } from "../credentials/claudeAuth.js";
import { materializeClaudeAuthBundle } from "../credentials/claudeMaterializer.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { buildActivityWatchdog, outputOnlyWatchdog } from "../ssh/activityWatchdog.js";
import { AnswererSchemaValidationError, AnswererStalledError, throwIfTransientSshFailure } from "./codex.js";
import { parseWithOneSchemaRepair } from "./answererRepair.js";
import type { AnswererAdapter, TokenUsage, UsageLimitSignal, WriterAdapter, WriterResult } from "./types.js";
import { findOpenRouterGenerationId, foldGenerationId } from "./openRouterGenerationId.js";
import { findTokenUsageBounded, parseJsonObject, splitNonEmptyJsonlLines } from "./findTokenUsage.js";
import { captureBaselineSha, captureGitStateAfterWriter } from "./writerGit.js";

// Claude CLI Writer + Answerer adapters. They mirror the Codex adapter
// contracts (same WriterAdapter/AnswererAdapter shapes, same SSH-execution +
// credential-ref materialization) but invoke the `claude` CLI. The Claude CLI
// streams JSON events on stdout (`--output-format stream-json`), so token usage
// and usage-limit signals are parsed from that stream the same way Codex parses
// its JSONL.

export interface ClaudeWriterDependencies {
  secrets: SecretStore;
  ssh: CommandSubstrate;
  target: RunnerHandle;
  credentialRef: string;
  runId: string;
  // The Claude model id this adapter pins (e.g. the routing chain entry's
  // `model`). Defaults to the CLI's configured default when omitted.
  model?: string;
  claudeHomeBaseDir?: string;
  // SaaS Tier-B #5: optional managed-endpoint base URL. When set (managed run),
  // the materializer writes a settings.json OpenRouter env block and the command
  // exports ANTHROPIC_BASE_URL (the `/api` form) + a blank ANTHROPIC_API_KEY, so
  // the CLI routes THROUGH OpenRouter (the cookbook path). Absent ⇒ BYOK: no
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
  // The OpenRouter generation id, when a managed (OpenRouter-routed) run surfaced
  // one. Folded onto tokenUsage so the recorder can query the REAL `usage.cost`.
  openRouterGenerationId?: string;
  // Count of NON-empty `stream-json` lines that failed to parse as JSON. Claude's
  // `stream-json` is one JSON object per line, so a positive count is contract
  // drift (silent-fallback hardening: a malformed line is no longer silently skipped).
  malformedLineCount?: number;
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
        managed: dependencies.endpointBaseUrl !== undefined,
        endpointBaseUrl: dependencies.endpointBaseUrl,
      });
      const baselineSha = await captureBaselineSha(dependencies.ssh, dependencies.target, opts.workspace);
      const claude = await dependencies.ssh.run(dependencies.target, {
        command: buildClaudeWriterCommand({
          configDir: auth.CLAUDE_CONFIG_DIR,
          workspace: opts.workspace,
          model: dependencies.model,
          managed: auth.managed,
          anthropicBaseUrl: auth.anthropicBaseUrl,
        }),
        stdin: opts.prompt,
        // AGENT exec (claude `stream-json`): output-driven + workspace liveness probe; never a time kill. `onWatchdogProgress` (task #24) is the cross-layer sign-of-life bridge — every advancing tick emits `writer.subtask.progress`; composes with the substrate's `MIN_NON_ADVANCING_NEIGHBOR_REPEATS_*` streak floor (ssh/watchdogProgress.ts), which is signature identity, never elapsed time.
        watchdog: buildActivityWatchdog({
          substrate: dependencies.ssh,
          target: dependencies.target,
          cls: "agent",
          workspace: opts.workspace,
          onProgress: opts.onWatchdogProgress,
        }),
      });
      const telemetry = parseClaudeStreamTelemetry(claude.stdout);
      const gitState = await captureGitStateAfterWriter(
        dependencies.ssh,
        dependencies.target,
        opts.workspace,
        baselineSha,
        "claude writer",
      );
      if (claude.stalled === true) {
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
  // The most recent call's per-call token usage (parsed from claude's stream-json
  // `usage`), surfaced for the cost path — see createCodexAnswerer for the rationale.
  let lastTokenUsage: TokenUsage | undefined;
  return {
    kind: "answerer",
    cli: "claude",
    authRef: dependencies.credentialRef,
    lastTokenUsage: () => lastTokenUsage,
    async runAnswerer(opts): Promise<TOutput> {
      const auth = await materializeClaudeAuthBundle({
        secrets: dependencies.secrets,
        ssh: dependencies.ssh,
        target: dependencies.target,
        ref: dependencies.credentialRef,
        runId: dependencies.runId,
        baseDir: dependencies.claudeHomeBaseDir,
        managed: dependencies.endpointBaseUrl !== undefined,
        endpointBaseUrl: dependencies.endpointBaseUrl,
      });
      const workspace = opts.workspace ?? answererWorkspacePath(dependencies, opts.outputSchema.name);
      const made = await dependencies.ssh.run(dependencies.target, {
        command: `mkdir -p ${quoteSshShellArg(workspace)}`,
        // INFRA workspace prep: output-driven watchdog, no wall-clock kill.
        watchdog: outputOnlyWatchdog(),
      });
      assertAnswererWorkspaceStep(made, `mkdir -p ${workspace}`);
      // Run one claude answerer call for `prompt` and return its final text — closed
      // over so the schema-repair pass can re-run it once with a repair prompt. Each
      // invocation refreshes lastTokenUsage. The base answerer-prompt scaffold (the
      // schema-name + JSON-Schema framing) is applied INSIDE so the repair re-sends
      // exactly the structured form the first call used.
      const runOnce = async (prompt: string): Promise<string> => {
        const result = await dependencies.ssh.run(dependencies.target, {
          command: buildClaudeAnswererCommand({
            configDir: auth.CLAUDE_CONFIG_DIR,
            workspace,
            model: dependencies.model,
            managed: auth.managed,
            anthropicBaseUrl: auth.anthropicBaseUrl,
          }),
          stdin: buildAnswererPrompt(prompt, opts.outputSchema.name, opts.outputSchema.jsonSchema),
          // AGENT answerer exec (claude `stream-json`): output-driven + workspace liveness probe; unbounded in time.
          watchdog: buildActivityWatchdog({
            substrate: dependencies.ssh,
            target: dependencies.target,
            cls: "agent",
            workspace,
          }),
        });
        const telemetry = parseClaudeStreamTelemetry(result.stdout);
        lastTokenUsage = telemetry.tokenUsage;
        // A TRANSIENT stall or SSH-connect failure → the typed transient (NOT deterministic),
        // so the loop-stage recovery RE-DRIVES this stage instead of discarding the spec loop.
        if (result.stalled === true) throw new AnswererStalledError(opts.outputSchema.name);
        throwIfTransientSshFailure(result.failure, opts.outputSchema.name);
        if (telemetry.usageLimit !== undefined) {
          throw new ClaudeUsageLimitError(opts.outputSchema.name, telemetry.usageLimit.message);
        }
        if (result.failure !== undefined || result.exitCode !== 0) {
          throw new Error(
            `Claude Answerer failed for schema ${opts.outputSchema.name}: exit ${result.exitCode ?? "unknown"}`,
          );
        }
        return extractClaudeFinalText(result.stdout);
      };
      const firstText = await runOnce(opts.prompt);
      // ONE bounded schema-repair pass (apex pre-run §7.1): a malformed-then-valid
      // answer repairs in a single cheap re-call instead of throwing the stage. A
      // second miss throws LOUD. Behavior is unchanged for a well-formed answer.
      return parseWithOneSchemaRepair({
        schema: opts.outputSchema,
        parse: (text) => parseClaudeAnswererOutput(text, opts.outputSchema),
        firstRawText: firstText,
        originalPrompt: opts.prompt,
        rerun: runOnce,
      });
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
  managed?: boolean;
  anthropicBaseUrl?: string;
}): string {
  return [
    `CLAUDE_CONFIG_DIR=${quoteSshShellArg(input.configDir)}`,
    ...claudeManagedEnv(input.managed, input.anthropicBaseUrl),
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

// SaaS Tier-B #5 (OpenRouter cookbook): a MANAGED run routes the Claude CLI
// THROUGH OpenRouter. The cookbook requires THREE env vars:
//   ANTHROPIC_BASE_URL = https://openrouter.ai/api   (the `/api` form, NOT
//                                                      `/api/v1`),
//   ANTHROPIC_AUTH_TOKEN = <OpenRouter key>,
//   ANTHROPIC_API_KEY = ""                            (explicitly blanked).
// The secret AUTH_TOKEN is materialized into CLAUDE_CONFIG_DIR/settings.json (it
// must NOT enter the command string); the two NON-secret vars are set here on
// the command. BYOK ⇒ no override (empty prefix), the CLI hits Anthropic
// directly (unchanged).
function claudeManagedEnv(managed?: boolean, anthropicBaseUrl?: string): string[] {
  if (managed !== true || anthropicBaseUrl === undefined) {
    return [];
  }
  return [`ANTHROPIC_BASE_URL=${quoteSshShellArg(anthropicBaseUrl)}`, `ANTHROPIC_API_KEY=${quoteSshShellArg("")}`];
}

// Answerer mode is read-only: no edit permission, no workspace mutation. The
// structured-output contract is enforced by us (prompt asks for JSON-only,
// matching the schema) since the Claude CLI has no --output-schema flag.
export function buildClaudeAnswererCommand(input: {
  configDir: string;
  workspace: string;
  model?: string;
  managed?: boolean;
  anthropicBaseUrl?: string;
}): string {
  return [
    `CLAUDE_CONFIG_DIR=${quoteSshShellArg(input.configDir)}`,
    ...claudeManagedEnv(input.managed, input.anthropicBaseUrl),
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

// Schema-first ordering (apex pre-run §7.9): the structured-output contract (schema
// name + instructions + the JSON Schema) is STATIC across every call of a given
// answerer, while `prompt` is the variable part. Emitting the static contract FIRST
// keeps the prompt prefix cache-stable so a repeated answerer call reuses the cached
// prefix instead of re-billing it. Output-parsing strips markdown fences defensively
// (parseClaudeAnswererOutput) even though we ask for none.
export function buildAnswererPrompt(prompt: string, schemaName: string, jsonSchema: Record<string, unknown>): string {
  return [
    `Respond with ONLY a single JSON object that validates against the "${schemaName}" JSON Schema below.`,
    "Do not wrap it in markdown fences or add any prose before or after the JSON.",
    "JSON Schema:",
    JSON.stringify(jsonSchema),
    "",
    prompt,
  ].join("\n");
}

// Parses the Claude CLI `stream-json` output: one JSON object per line. Token
// usage lives on `result`/`assistant` events under a `usage` object; a
// usage-limit error surfaces as an `error`/`result` event carrying the stable
// "usage limit" phrase (matched on the phrase, not the event type).
export function parseClaudeStreamTelemetry(stdout: string): ClaudeEventTelemetry {
  const lines = splitNonEmptyJsonlLines(stdout);
  let tokenUsage: TokenUsage | undefined;
  let usageLimit: UsageLimitSignal | undefined;
  let openRouterGenerationId: string | undefined;
  // `stream-json` is one JSON object per line — a non-empty line that fails to
  // parse is contract drift, not a benign blank. Count it (silent-fallback
  // hardening) so a malformed line surfaces instead of being silently skipped.
  let malformedLineCount = 0;
  for (const line of lines) {
    const parsed = parseJsonObject(line);
    if (parsed === undefined) {
      malformedLineCount += 1;
      continue;
    }
    tokenUsage = findTokenUsage(parsed) ?? tokenUsage;
    usageLimit = detectUsageLimit(parsed) ?? usageLimit;
    openRouterGenerationId = findOpenRouterGenerationId(parsed) ?? openRouterGenerationId;
  }
  return {
    rawEventCount: lines.length,
    tokenUsage: foldGenerationId(tokenUsage, openRouterGenerationId),
    usageLimit,
    openRouterGenerationId,
    malformedLineCount,
  };
}

// Pulls the final assistant message text out of the stream-json events. Claude
// emits a terminal `{"type":"result","result":"<text>"}`; we fall back to the
// last assistant text block if the result envelope is absent.
export function extractClaudeFinalText(stdout: string): string {
  const lines = splitNonEmptyJsonlLines(stdout);
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
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/mu.exec(text.trim());
  return fence?.[1] ?? text;
}
// detectUsageLimit recognizes subscription-window rejections by stable usage,
// rate-limit, and OpenRouter billing wording rather than the event type.
function detectUsageLimit(event: Record<string, unknown>): UsageLimitSignal | undefined {
  const candidates: unknown[] = [
    event["message"],
    event["result"],
    event["error"],
    event["status"],
    event["statusCode"],
    event["code"],
  ];
  const errorField = event["error"];
  if (typeof errorField === "object" && errorField !== null && !Array.isArray(errorField)) {
    const error = errorField as Record<string, unknown>;
    candidates.push(error["message"], error["status"], error["statusCode"], error["code"]);
  }
  for (const candidate of candidates) {
    if (
      (typeof candidate === "number" && (candidate === 402 || candidate === 429)) ||
      (typeof candidate === "string" &&
        /usage limit|rate limit|insufficient credits|quota|\b(?:402|429)\b/iu.test(candidate))
    ) {
      return { message: String(candidate) };
    }
  }
  return undefined;
}

// Walks one parsed Claude JSONL event for its usage record. BOUNDED on depth +
// node count (a hostile/buggy deeply-nested event must not blow the stack); on
// hitting a bound it emits a LOUD `usage-parse-bounded` signal rather than
// silently dropping usage. The Claude disjoint shape is `tokenUsageFromRecord`.
function findTokenUsage(value: unknown): TokenUsage | undefined {
  return findTokenUsageBounded("claude", value, tokenUsageFromRecord);
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

function answererWorkspacePath(dependencies: ClaudeAnswererDependencies, schemaName: string): string {
  // Writable by the runner's `tanren` user — /tmp is uid-owned + denies mkdir, so
  // the per-run scratch lives under tanren's home (same base as the materializers).
  const baseDir = dependencies.answererWorkspaceBaseDir ?? "/home/tanren/.tanren/runs";
  return `${baseDir}/${dependencies.runId}/${safeSchemaFileName(schemaName)}`;
}

function safeSchemaFileName(schemaName: string): string {
  return schemaName.replaceAll(/[^a-zA-Z0-9._-]/gu, "_");
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// A failed workspace-prep SSH step (e.g. mkdir denied on a non-writable base) must
// be LOUD — otherwise the harness `--cd`s into a dir that was never created and the
// real cause is masked by a cryptic downstream error. (no-silent-fallbacks doctrine.)
function assertAnswererWorkspaceStep(result: CommandResult, step: string): void {
  if (result.exitCode !== 0 || result.failure !== undefined || result.stalled === true) {
    throw new Error(
      `Claude Answerer workspace prep failed (${step}): exit ${result.exitCode ?? "unknown"}` +
        `${result.stalled === true ? " (stalled — no sign of life)" : ""} | stderr: ${result.stderr.slice(-500)}`,
    );
  }
}

function failedResult(
  exitReason: "timeout" | "crashed" | "window_exhausted",
  telemetry: ClaudeEventTelemetry,
  gitState: Pick<WriterResult, "diff" | "commits">,
): WriterResult {
  return { ...gitState, exitReason, tokenUsage: telemetry.tokenUsage, telemetry };
}

// Re-export so callers can persist a refreshed Claude auth bundle the same way the Codex path does (best-effort write-back lives in the registry/workflow).
export { storeClaudeAuthBundle };
