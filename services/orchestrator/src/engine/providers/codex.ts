import type { SshTarget } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { SshSubstrate } from "../contracts/sshSubstrate.js";
import { storeCodexAuthBundle } from "../credentials/codexAuth.js";
import { materializeCodexAuthBundle } from "../credentials/codexMaterializer.js";
import { quoteSshShellArg } from "../ssh/command.js";
import type { AnswererAdapter, TokenUsage, UsageLimitSignal, WriterAdapter, WriterResult } from "./types.js";
import { captureBaselineSha, captureGitStateAfterCodex } from "./codexGit.js";

export interface CodexWriterDependencies {
  secrets: SecretStore;
  ssh: SshSubstrate;
  target: SshTarget;
  credentialRef: string;
  runId: string;
  codexHomeBaseDir?: string;
  // SaaS Tier-B #5: optional managed-endpoint base URL. When set (managed run),
  // codex is pointed at this OpenAI-compatible endpoint (the platform OpenRouter
  // shell) via OPENAI_BASE_URL. Absent ⇒ BYOK: no override (unchanged).
  endpointBaseUrl?: string;
}

export interface CodexEventTelemetry {
  rawEventCount: number;
  tokenUsage?: TokenUsage;
  usageLimit?: UsageLimitSignal;
}

// Raised by the Answerer path when Codex authenticated but the account's
// usage limit / subscription window is exhausted. Distinct from a generic
// Codex failure so the workflow can escalate it as window pressure
// (PROJECT_BRIEF §4.3) rather than treating it as a crash.
export class CodexUsageLimitError extends Error {
  constructor(
    readonly schemaName: string,
    readonly providerMessage: string,
  ) {
    super(`Codex usage limit reached for schema ${schemaName}: ${providerMessage}`);
    this.name = "CodexUsageLimitError";
  }
}

export interface CodexAnswererDependencies extends CodexWriterDependencies {
  answererWorkspaceBaseDir?: string;
}

export interface CodexAnswererTelemetry extends CodexEventTelemetry {
  schemaName: string;
}

export class AnswererSchemaValidationError extends Error {
  constructor(schemaName: string, message: string) {
    super(`Answerer response failed ${schemaName} validation: ${message}`);
    this.name = "AnswererSchemaValidationError";
  }
}

export function createCodexWriter(dependencies: CodexWriterDependencies): WriterAdapter {
  return {
    kind: "writer",
    cli: "codex",
    authRef: dependencies.credentialRef,
    async runWriter(opts): Promise<WriterResult> {
      const auth = await materializeCodexAuthBundle({
        secrets: dependencies.secrets,
        ssh: dependencies.ssh,
        target: dependencies.target,
        ref: dependencies.credentialRef,
        runId: dependencies.runId,
        baseDir: dependencies.codexHomeBaseDir,
        timeoutMs: Math.min(opts.timeoutMs, 30_000),
      });
      const baselineSha = await captureBaselineSha(
        dependencies.ssh,
        dependencies.target,
        opts.workspace,
        opts.timeoutMs,
      );
      const codex = await dependencies.ssh.run(dependencies.target, {
        command: buildCodexExecCommand({
          codexHome: auth.CODEX_HOME,
          workspace: opts.workspace,
          endpointBaseUrl: dependencies.endpointBaseUrl,
        }),
        stdin: opts.prompt,
        timeoutMs: opts.timeoutMs,
      });
      const telemetry = parseCodexJsonlTelemetry(codex.stdout);
      await persistRefreshedCodexAuthBestEffort({
        secrets: dependencies.secrets,
        ssh: dependencies.ssh,
        target: dependencies.target,
        ref: dependencies.credentialRef,
        codexHome: auth.CODEX_HOME,
        timeoutMs: Math.min(opts.timeoutMs, 30_000),
      });

      const gitState = await captureGitStateAfterCodex(
        dependencies.ssh,
        dependencies.target,
        opts.workspace,
        baselineSha,
        opts.timeoutMs,
      );
      if (codex.timedOut) {
        return failedResult("timeout", telemetry, gitState);
      }
      // Usage-limit exhaustion is an authenticated-but-out-of-quota state, not
      // a crash. Surface it distinctly so the workflow escalates window
      // pressure (PROJECT_BRIEF §4.3) instead of retrying a doomed call.
      if (telemetry.usageLimit !== undefined) {
        return failedResult("window_exhausted", telemetry, gitState);
      }
      if (codex.failure !== undefined || codex.exitCode !== 0) {
        return failedResult("crashed", telemetry, gitState);
      }

      return {
        ...gitState,
        exitReason: "completed",
        tokenUsage: telemetry.tokenUsage,
        telemetry,
      };
    },
  };
}

export function createCodexAnswerer<TOutput>(dependencies: CodexAnswererDependencies): AnswererAdapter<TOutput> {
  return {
    kind: "answerer",
    cli: "codex",
    authRef: dependencies.credentialRef,
    async runAnswerer(opts): Promise<TOutput> {
      const auth = await materializeCodexAuthBundle({
        secrets: dependencies.secrets,
        ssh: dependencies.ssh,
        target: dependencies.target,
        ref: dependencies.credentialRef,
        runId: dependencies.runId,
        baseDir: dependencies.codexHomeBaseDir,
        timeoutMs: Math.min(opts.timeoutMs, 30_000),
      });
      const workspace = opts.workspace ?? answererWorkspacePath(dependencies, opts.outputSchema.name);
      const schemaPath = `${auth.CODEX_HOME}/${safeSchemaFileName(opts.outputSchema.name)}.schema.json`;
      const outputPath = `${auth.CODEX_HOME}/${safeSchemaFileName(opts.outputSchema.name)}.response.json`;
      await prepareCodexAnswererWorkspace(
        dependencies,
        workspace,
        schemaPath,
        opts.outputSchema.jsonSchema,
        opts.timeoutMs,
      );
      const result = await dependencies.ssh.run(dependencies.target, {
        command: buildCodexAnswererExecCommand({
          codexHome: auth.CODEX_HOME,
          workspace,
          schemaPath,
          outputPath,
          endpointBaseUrl: dependencies.endpointBaseUrl,
        }),
        stdin: opts.prompt,
        timeoutMs: opts.timeoutMs,
      });
      const telemetry = parseCodexJsonlTelemetry(result.stdout);
      await persistRefreshedCodexAuthBestEffort({
        secrets: dependencies.secrets,
        ssh: dependencies.ssh,
        target: dependencies.target,
        ref: dependencies.credentialRef,
        codexHome: auth.CODEX_HOME,
        timeoutMs: Math.min(opts.timeoutMs, 30_000),
      });
      if (result.timedOut) {
        throw new Error(`Codex Answerer timed out for schema ${opts.outputSchema.name}`);
      }
      if (telemetry.usageLimit !== undefined) {
        throw new CodexUsageLimitError(opts.outputSchema.name, telemetry.usageLimit.message);
      }
      if (result.failure !== undefined || result.exitCode !== 0) {
        throw new Error(
          `Codex Answerer failed for schema ${opts.outputSchema.name}: exit ${result.exitCode ?? "unknown"}`,
        );
      }
      const response = await dependencies.ssh.run(dependencies.target, {
        command: `cat ${quoteSshShellArg(outputPath)}`,
        timeoutMs: Math.min(opts.timeoutMs, 30_000),
      });
      if (response.exitCode !== 0 || response.failure !== undefined || response.timedOut) {
        throw new Error(`Codex Answerer response capture failed for schema ${opts.outputSchema.name}`);
      }
      return parseStructuredAnswererOutput(response.stdout, opts.outputSchema, telemetry);
    },
  };
}

async function persistRefreshedCodexAuthBestEffort(input: {
  secrets: SecretStore;
  ssh: SshSubstrate;
  target: SshTarget;
  ref: string;
  codexHome: string;
  timeoutMs: number;
}): Promise<void> {
  const result = await input.ssh.run(input.target, {
    command: `cat ${quoteSshShellArg(`${input.codexHome}/auth.json`)}`,
    timeoutMs: input.timeoutMs,
  });
  if (result.exitCode !== 0 || result.timedOut || result.failure !== undefined) {
    return;
  }
  try {
    await storeCodexAuthBundle(input.secrets, { ref: input.ref, authJson: result.stdout });
  } catch {
    // best-effort: a failed auth-bundle store is non-fatal to the run
  }
}

export function buildCodexExecCommand(input: {
  codexHome: string;
  workspace: string;
  endpointBaseUrl?: string;
}): string {
  return [
    `CODEX_HOME=${quoteSshShellArg(input.codexHome)}`,
    ...codexEndpointEnv(input.endpointBaseUrl),
    "codex exec",
    "--sandbox workspace-write",
    "--json",
    "--ignore-user-config",
    "--cd",
    quoteSshShellArg(input.workspace),
    "-",
  ].join(" ");
}

export function buildCodexAnswererExecCommand(input: {
  codexHome: string;
  workspace: string;
  schemaPath: string;
  outputPath: string;
  endpointBaseUrl?: string;
}): string {
  return [
    `CODEX_HOME=${quoteSshShellArg(input.codexHome)}`,
    ...codexEndpointEnv(input.endpointBaseUrl),
    "codex exec",
    "--sandbox read-only",
    "--json",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--cd",
    quoteSshShellArg(input.workspace),
    "--output-schema",
    quoteSshShellArg(input.schemaPath),
    "--output-last-message",
    quoteSshShellArg(input.outputPath),
    "-",
  ].join(" ");
}

// SaaS Tier-B #5: the managed-endpoint env override codex reads. When a managed
// run resolves the platform endpoint, we set OPENAI_BASE_URL so codex's API
// calls go to the platform OpenRouter shell. BYOK ⇒ no override (unchanged).
function codexEndpointEnv(endpointBaseUrl?: string): string[] {
  return endpointBaseUrl === undefined ? [] : [`OPENAI_BASE_URL=${quoteSshShellArg(endpointBaseUrl)}`];
}

export function parseCodexJsonlTelemetry(stdout: string): CodexEventTelemetry {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.trim() !== "");
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

// detectUsageLimit recognizes the Codex JSONL events emitted when the account
// hits its usage limit:
//   {"type":"error","message":"You've hit your usage limit. ... try again at ..."}
//   {"type":"turn.failed","error":{"message":"You've hit your usage limit. ..."}}
// Matched on the stable "usage limit" phrase rather than the event type so a
// minor CLI wording change in the error envelope still surfaces it.
function detectUsageLimit(event: Record<string, unknown>): UsageLimitSignal | undefined {
  const candidates: unknown[] = [event["message"]];
  const errorField = event["error"];
  if (typeof errorField === "object" && errorField !== null && !Array.isArray(errorField)) {
    candidates.push((errorField as Record<string, unknown>)["message"]);
  } else {
    candidates.push(errorField);
  }
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /usage limit/iu.test(candidate)) {
      return { message: candidate };
    }
  }
  return undefined;
}

export function parseStructuredAnswererOutput<TOutput>(
  stdout: string,
  schema: { name: string; parse(value: unknown): TOutput },
  _telemetry?: CodexAnswererTelemetry | CodexEventTelemetry,
): TOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new AnswererSchemaValidationError(schema.name, `invalid JSON: ${messageFromUnknown(error)}`);
  }
  try {
    return schema.parse(parsed);
  } catch (error) {
    throw new AnswererSchemaValidationError(schema.name, messageFromUnknown(error));
  }
}

async function prepareCodexAnswererWorkspace(
  dependencies: CodexAnswererDependencies,
  workspace: string,
  schemaPath: string,
  jsonSchema: Record<string, unknown>,
  timeoutMs: number,
): Promise<void> {
  await dependencies.ssh.run(dependencies.target, {
    command: `mkdir -p ${quoteSshShellArg(workspace)}`,
    timeoutMs: Math.min(timeoutMs, 30_000),
  });
  await dependencies.ssh.run(dependencies.target, {
    command: `cat > ${quoteSshShellArg(schemaPath)}`,
    stdin: JSON.stringify(jsonSchema),
    timeoutMs: Math.min(timeoutMs, 30_000),
  });
}

function answererWorkspacePath(dependencies: CodexAnswererDependencies, schemaName: string): string {
  const baseDir = dependencies.answererWorkspaceBaseDir ?? "/tmp/tanren-answerer-runs";
  return `${baseDir}/${dependencies.runId}/${safeSchemaFileName(schemaName)}`;
}

function safeSchemaFileName(schemaName: string): string {
  return schemaName.replaceAll(/[^a-zA-Z0-9._-]/gu, "_");
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

// Transforms Codex's INCLUSIVE token shape into the disjoint TokenUsage
// buckets. In Codex JSONL, cached_input_tokens ⊆ input_tokens and
// reasoning_output_tokens ⊆ output_tokens, so we subtract the overlaps to
// keep the buckets mutually exclusive (total = sum of parts).
function tokenUsageFromRecord(record: Record<string, unknown>): TokenUsage | undefined {
  const rawInput = numberField(record, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]);
  const rawOutput = numberField(record, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]);
  if (rawInput === undefined || rawOutput === undefined) {
    return undefined;
  }
  const cachedInputTokens =
    numberField(record, ["cached_input_tokens", "cachedInputTokens", "cache_read_input_tokens"]) ?? 0;
  const cacheCreationTokens =
    numberField(record, ["cache_creation_input_tokens", "cacheCreationTokens", "cache_creation_tokens"]) ?? 0;
  const reasoningOutputTokens = numberField(record, ["reasoning_output_tokens", "reasoningOutputTokens"]) ?? 0;
  // de-overlap: codex input includes cached
  const inputTokens = Math.max(0, rawInput - cachedInputTokens);
  // de-overlap: codex output includes reasoning
  const outputTokens = Math.max(0, rawOutput - reasoningOutputTokens);
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

function failedResult(
  exitReason: "timeout" | "crashed" | "window_exhausted",
  telemetry: CodexEventTelemetry,
  gitState: Pick<WriterResult, "diff" | "commits">,
): WriterResult {
  return { ...gitState, exitReason, tokenUsage: telemetry.tokenUsage, telemetry };
}
