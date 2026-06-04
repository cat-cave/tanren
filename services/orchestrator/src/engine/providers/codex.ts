import type { SshTarget } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { SshSubstrate } from "../contracts/sshSubstrate.js";
import { storeCodexAuthBundle } from "../credentials/codexAuth.js";
import { codexManagedEnvPath, materializeCodexAuthBundle } from "../credentials/codexMaterializer.js";
import { quoteSshShellArg } from "../ssh/command.js";
import type { AnswererAdapter, TokenUsage, UsageLimitSignal, WriterAdapter, WriterResult } from "./types.js";
import { findOpenRouterGenerationId, foldGenerationId } from "./openRouterGenerationId.js";
import { captureBaselineSha, captureGitStateAfterCodex } from "./codexGit.js";

export interface CodexWriterDependencies {
  secrets: SecretStore;
  ssh: SshSubstrate;
  target: SshTarget;
  credentialRef: string;
  runId: string;
  codexHomeBaseDir?: string;
  // SaaS Tier-B #5: optional managed-endpoint base URL. When set (managed run),
  // the materializer writes codex's config.toml OpenRouter provider block
  // (base_url = this endpoint) + an OPENROUTER_API_KEY env file the exec sources,
  // so codex routes THROUGH OpenRouter. Absent ⇒ BYOK: no override (unchanged).
  endpointBaseUrl?: string;
}

export interface CodexEventTelemetry {
  rawEventCount: number;
  tokenUsage?: TokenUsage;
  usageLimit?: UsageLimitSignal;
  // The OpenRouter generation id (managed run); folded onto tokenUsage so the cost
  // recorder can query the REAL `usage.cost` (see TokenUsage.openRouterGenerationId).
  openRouterGenerationId?: string;
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
      // SaaS Tier-B #5: a MANAGED run carries an endpointBaseUrl (the platform
      // OpenRouter shell). In managed mode the credential is a plain OpenRouter
      // API key, so the materializer writes codex's config.toml OpenRouter
      // provider block + an OPENROUTER_API_KEY env file (the cookbook path)
      // instead of validating a ChatGPT bundle.
      const managed = dependencies.endpointBaseUrl !== undefined;
      const auth = await materializeCodexAuthBundle({
        secrets: dependencies.secrets,
        ssh: dependencies.ssh,
        target: dependencies.target,
        ref: dependencies.credentialRef,
        runId: dependencies.runId,
        baseDir: dependencies.codexHomeBaseDir,
        timeoutMs: Math.min(opts.timeoutMs, 30_000),
        managed,
        endpointBaseUrl: dependencies.endpointBaseUrl,
      });
      // The diff/log baseline. In a production run this is the run's BASE sha
      // (the clone point), threaded via opts.baseSha and captured ONCE after the
      // clone — so each subtask is judged against the CUMULATIVE workspace state
      // vs the run base, not the per-subtask HEAD delta. That keeps a replanned,
      // already-satisfied subtask's diff non-empty (the file a prior subtask
      // committed still shows) so the checker passes instead of false-rejecting
      // an empty per-iteration delta. When no baseSha is threaded (no production
      // caller; only a non-threaded/unit caller) we fall back to HEAD-at-start.
      const baselineSha =
        opts.baseSha ??
        (await captureBaselineSha(dependencies.ssh, dependencies.target, opts.workspace, opts.timeoutMs));
      const codex = await dependencies.ssh.run(dependencies.target, {
        command: buildCodexExecCommand({
          codexHome: auth.CODEX_HOME,
          workspace: opts.workspace,
          managed: auth.managed,
        }),
        stdin: opts.prompt,
        timeoutMs: opts.timeoutMs,
      });
      const telemetry = parseCodexJsonlTelemetry(codex.stdout);
      // Auth write-back is a ChatGPT-bundle refresh: codex rotates its
      // access/refresh tokens during a run and we persist the new bundle. A
      // managed run authenticates with a static API key (no token rotation), and
      // its auth.json is not a codex bundle, so there is nothing to write back —
      // skip it (storeCodexAuthBundle would reject the non-codex ref anyway).
      if (!managed) {
        await persistRefreshedCodexAuthBestEffort({
          secrets: dependencies.secrets,
          ssh: dependencies.ssh,
          target: dependencies.target,
          ref: dependencies.credentialRef,
          codexHome: auth.CODEX_HOME,
          timeoutMs: Math.min(opts.timeoutMs, 30_000),
        });
      }

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
      // SaaS Tier-B #5: managed ⇒ config.toml OpenRouter provider block + an
      // OPENROUTER_API_KEY env file (see the writer path for the rationale).
      const managed = dependencies.endpointBaseUrl !== undefined;
      const auth = await materializeCodexAuthBundle({
        secrets: dependencies.secrets,
        ssh: dependencies.ssh,
        target: dependencies.target,
        ref: dependencies.credentialRef,
        runId: dependencies.runId,
        baseDir: dependencies.codexHomeBaseDir,
        timeoutMs: Math.min(opts.timeoutMs, 30_000),
        managed,
        endpointBaseUrl: dependencies.endpointBaseUrl,
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
          managed: auth.managed,
        }),
        stdin: opts.prompt,
        timeoutMs: opts.timeoutMs,
      });
      const telemetry = parseCodexJsonlTelemetry(result.stdout);
      // Managed (API-key) auth has no token to refresh — skip the write-back
      // (mirrors the writer path).
      if (!managed) {
        await persistRefreshedCodexAuthBestEffort({
          secrets: dependencies.secrets,
          ssh: dependencies.ssh,
          target: dependencies.target,
          ref: dependencies.credentialRef,
          codexHome: auth.CODEX_HOME,
          timeoutMs: Math.min(opts.timeoutMs, 30_000),
        });
      }
      if (result.timedOut) {
        throw new Error(`Codex Answerer timed out for schema ${opts.outputSchema.name}`);
      }
      if (telemetry.usageLimit !== undefined) {
        throw new CodexUsageLimitError(opts.outputSchema.name, telemetry.usageLimit.message);
      }
      if (result.failure !== undefined || result.exitCode !== 0) {
        throw new Error(
          `Codex Answerer failed for schema ${opts.outputSchema.name}: exit ${result.exitCode ?? "unknown"}` +
            `${result.failure === undefined ? "" : ` failure=${result.failure}`}` +
            ` | stderr: ${harnessOutputTail(result.stderr)} | stdout: ${harnessOutputTail(result.stdout)}`,
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

export function buildCodexExecCommand(input: { codexHome: string; workspace: string; managed?: boolean }): string {
  return [
    ...managedKeyEnvPrefix(input.codexHome, input.managed),
    `CODEX_HOME=${quoteSshShellArg(input.codexHome)}`,
    "codex exec",
    "--sandbox workspace-write",
    "--json",
    // BYOK: ignore any host-level codex config. MANAGED: we DELIBERATELY do NOT
    // pass --ignore-user-config so codex reads the per-run CODEX_HOME/config.toml
    // that declares the OpenRouter provider + selects it (the cookbook path).
    ...codexUserConfigFlag(input.managed),
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
  managed?: boolean;
}): string {
  return [
    ...managedKeyEnvPrefix(input.codexHome, input.managed),
    `CODEX_HOME=${quoteSshShellArg(input.codexHome)}`,
    "codex exec",
    "--sandbox read-only",
    "--json",
    ...codexUserConfigFlag(input.managed),
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

// SaaS Tier-B #5 (OpenRouter cookbook): a MANAGED run sources the per-run env
// file the materializer wrote (chmod 600, exporting OPENROUTER_API_KEY — the
// `env_key` the config.toml provider block names) before invoking codex, so the
// platform key reaches codex via the env WITHOUT ever appearing in the command
// string. BYOK ⇒ no prefix (unchanged).
function managedKeyEnvPrefix(codexHome: string, managed?: boolean): string[] {
  return managed === true ? [`.`, quoteSshShellArg(codexManagedEnvPath(codexHome)), "&&"] : [];
}

// BYOK pins `--ignore-user-config`; MANAGED omits it so CODEX_HOME/config.toml is
// honored. (UNVERIFIED LIVE — see the file-level NOTE below.)
function codexUserConfigFlag(managed?: boolean): string[] {
  return managed === true ? [] : ["--ignore-user-config"];
}

// ─────────────────────────────────────────────────────────────────────────────
// NOTE (codex MANAGED path — needs a LIVE codex verification before relying on
// it in production): OpenRouter's Codex-CLI cookbook configures codex via
// `config.toml` (`model_provider = "openrouter"` + `[model_providers.openrouter]`
// with `base_url` + `env_key="OPENROUTER_API_KEY"`). We materialize exactly that
// into the per-run CODEX_HOME and DROP `--ignore-user-config` for managed runs so
// codex reads it. It is UNVERIFIED whether `codex exec` (a) honors a CODEX_HOME
// `config.toml` written this way and (b) routes through OpenRouter end-to-end
// under these flags. The BYOK path (auth.json + `--ignore-user-config`) is UNCHANGED
// and remains the proven one. Verify managed codex against a real OpenRouter key
// before depending on it.
// ─────────────────────────────────────────────────────────────────────────────

// The tail of a harness stream, whitespace-collapsed, for surfacing the real
// reason an Answerer failed (e.g. an OpenAI structured-output 400) in the error.
function harnessOutputTail(stream: string | undefined): string {
  return (stream ?? "").slice(-1000).replaceAll(/\s+/gu, " ").trim();
}

export function parseCodexJsonlTelemetry(stdout: string): CodexEventTelemetry {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.trim() !== "");
  let tokenUsage: TokenUsage | undefined;
  let usageLimit: UsageLimitSignal | undefined;
  let openRouterGenerationId: string | undefined;
  for (const line of lines) {
    const parsed = parseJsonObject(line);
    if (parsed === undefined) {
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
  };
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

// Transforms Codex's INCLUSIVE token shape into the disjoint TokenUsage buckets. In
// Codex JSONL, cached_input_tokens ⊆ input_tokens and reasoning_output_tokens ⊆
// output_tokens, so we subtract the overlaps to keep the buckets mutually exclusive.
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
