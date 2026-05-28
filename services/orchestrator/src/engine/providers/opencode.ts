import type { SshTarget } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { SshSubstrate } from "../contracts/sshSubstrate.js";
import { storeOpencodeAuthBundle } from "../credentials/opencodeAuth.js";
import { materializeOpencodeAuthBundle } from "../credentials/opencodeMaterializer.js";
import { quoteSshShellArg } from "../ssh/command.js";
import type { TokenUsage, UsageLimitSignal, WriterAdapter, WriterResult } from "./types.js";
import { captureBaselineSha, captureGitStateAfterWriter } from "./writerGit.js";

// P3-0012: opencode CLI Writer adapter. opencode is a Writer-only provider in
// this expansion and is pinned to the Zai GLM 5.1 model (`zai/glm-5.1`). It
// mirrors the Codex/Claude Writer contract (same WriterAdapter shape, same
// SSH-execution + credential-ref materialization) but invokes the `opencode`
// CLI in non-interactive `run` mode. opencode streams JSON events on stdout
// (`--print-logs --json`); token usage and usage-limit signals are parsed from
// that stream the same way Codex/Claude parse their JSONL.
//
// (The previously-considered Wafer provider was discontinued 2026-05-27 and is
// intentionally NOT offered — opencode here is Zai GLM 5.1 only.)

// The single opencode model this expansion offers. Pinned as provider/model so
// it lines up with both the opencode `--model` flag and the routing chain's
// `model` field. A routing chain entry of { cli: "opencode", model: this } is
// resolvable by buildAdaptersForRole.
export const ZAI_GLM_MODEL = "zai/glm-5.1";

export interface OpencodeWriterDependencies {
  secrets: SecretStore;
  ssh: SshSubstrate;
  target: SshTarget;
  credentialRef: string;
  runId: string;
  // The opencode model id this adapter pins. Defaults to the Zai GLM 5.1 model
  // (ZAI_GLM_MODEL); only Zai GLM is supported by this expansion.
  model?: string;
  opencodeDataBaseDir?: string;
}

export interface OpencodeEventTelemetry {
  rawEventCount: number;
  tokenUsage?: TokenUsage;
  usageLimit?: UsageLimitSignal;
}

export function createOpencodeWriter(dependencies: OpencodeWriterDependencies): WriterAdapter {
  return {
    kind: "writer",
    cli: "opencode",
    authRef: dependencies.credentialRef,
    async runWriter(opts): Promise<WriterResult> {
      const auth = await materializeOpencodeAuthBundle({
        secrets: dependencies.secrets,
        ssh: dependencies.ssh,
        target: dependencies.target,
        ref: dependencies.credentialRef,
        runId: dependencies.runId,
        baseDir: dependencies.opencodeDataBaseDir,
        timeoutMs: Math.min(opts.timeoutMs, 30_000)
      });
      const baselineSha = await captureBaselineSha(dependencies.ssh, dependencies.target, opts.workspace, opts.timeoutMs);
      const opencode = await dependencies.ssh.run(dependencies.target, {
        command: buildOpencodeWriterCommand({
          dataHome: auth.XDG_DATA_HOME,
          workspace: opts.workspace,
          model: dependencies.model ?? ZAI_GLM_MODEL
        }),
        stdin: opts.prompt,
        timeoutMs: opts.timeoutMs
      });
      const telemetry = parseOpencodeStreamTelemetry(opencode.stdout);
      const gitState = await captureGitStateAfterWriter(
        dependencies.ssh,
        dependencies.target,
        opts.workspace,
        baselineSha,
        "opencode writer",
        opts.timeoutMs
      );
      if (opencode.timedOut) {
        return failedResult("timeout", telemetry, gitState);
      }
      if (telemetry.usageLimit !== undefined) {
        return failedResult("window_exhausted", telemetry, gitState);
      }
      if (opencode.failure !== undefined || opencode.exitCode !== 0) {
        return failedResult("crashed", telemetry, gitState);
      }
      return { ...gitState, exitReason: "completed", tokenUsage: telemetry.tokenUsage, telemetry };
    }
  };
}

// opencode reads the prompt on stdin and writes the run to the workspace. We
// point XDG_DATA_HOME at the per-run data dir (where the materialized auth.json
// lives), pin the model, and run with the workspace as the project directory.
// `--print-logs` emits the structured event stream we parse telemetry from.
export function buildOpencodeWriterCommand(input: { dataHome: string; workspace: string; model: string }): string {
  return [
    `XDG_DATA_HOME=${quoteSshShellArg(input.dataHome)}`,
    "opencode",
    "run",
    "--print-logs",
    "--model",
    quoteSshShellArg(input.model),
    "--cwd",
    quoteSshShellArg(input.workspace),
    "-"
  ].join(" ");
}

// Parses opencode's `--print-logs` output: one JSON object per line. Token
// usage lives under a `usage`/`tokens` object on a completion event; a
// usage-limit error surfaces as an `error` event carrying the stable "usage
// limit" phrase (matched on the phrase, not the event type, so a minor CLI
// wording change still surfaces it).
export function parseOpencodeStreamTelemetry(stdout: string): OpencodeEventTelemetry {
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

function detectUsageLimit(event: Record<string, unknown>): UsageLimitSignal | undefined {
  const candidates: unknown[] = [event.message, event.error];
  const errorField = event.error;
  if (typeof errorField === "object" && errorField !== null && !Array.isArray(errorField)) {
    candidates.push((errorField as Record<string, unknown>).message);
  }
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /usage limit|rate limit/i.test(candidate)) {
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

// opencode reports already-DISJOINT token buckets (input excludes cache reads;
// cache read/write are separate), so we map straight across with no de-overlap
// (unlike the Codex inclusive shape).
function tokenUsageFromRecord(record: Record<string, unknown>): TokenUsage | undefined {
  const inputTokens = numberField(record, ["input_tokens", "inputTokens", "input", "prompt_tokens"]);
  const outputTokens = numberField(record, ["output_tokens", "outputTokens", "output", "completion_tokens"]);
  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined;
  }
  const cachedInputTokens = numberField(record, ["cache_read_input_tokens", "cache_read", "cachedInputTokens"]) ?? 0;
  const cacheCreationTokens = numberField(record, ["cache_write_input_tokens", "cache_write", "cacheCreationTokens"]) ?? 0;
  const reasoningOutputTokens = numberField(record, ["reasoning_output_tokens", "reasoning", "reasoningOutputTokens"]) ?? 0;
  const totalTokens =
    numberField(record, ["total_tokens", "totalTokens"]) ??
    inputTokens + cachedInputTokens + cacheCreationTokens + outputTokens + reasoningOutputTokens;
  return { inputTokens, cachedInputTokens, cacheCreationTokens, outputTokens, reasoningOutputTokens, totalTokens };
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
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function failedResult(
  exitReason: "timeout" | "crashed" | "window_exhausted",
  telemetry: OpencodeEventTelemetry,
  gitState: Pick<WriterResult, "diff" | "commits">
): WriterResult {
  return { ...gitState, exitReason, tokenUsage: telemetry.tokenUsage, telemetry };
}

// Re-export so callers can persist a refreshed opencode auth bundle the same
// way the Codex/Claude paths do (best-effort write-back lives in the workflow).
export { storeOpencodeAuthBundle };
