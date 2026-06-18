import type { RunnerHandle } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import { storeOpencodeAuthBundle } from "../credentials/opencodeAuth.js";
import { materializeOpencodeAuthBundle } from "../credentials/opencodeMaterializer.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { buildActivityWatchdog } from "../ssh/activityWatchdog.js";
import type { TokenUsage, UsageLimitSignal, WriterAdapter, WriterResult } from "./types.js";
import { findOpenRouterGenerationId, foldGenerationId } from "./openRouterGenerationId.js";
import { findTokenUsageBounded } from "./findTokenUsage.js";
import { captureBaselineSha, captureGitStateAfterWriter } from "./writerGit.js";

// opencode CLI Writer adapter. opencode is a Writer-only provider in
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
  ssh: CommandSubstrate;
  target: RunnerHandle;
  credentialRef: string;
  runId: string;
  // The opencode model id this adapter pins. Defaults to the Zai GLM 5.1 model
  // (ZAI_GLM_MODEL); only Zai GLM is supported by this expansion.
  model?: string;
  opencodeDataBaseDir?: string;
  // SaaS Tier-B #5: optional managed-endpoint base URL. When set (managed run),
  // the materializer writes an OpenRouter auth.json + opencode.json and the
  // writer selects the openrouter provider (the cookbook path), so opencode
  // routes THROUGH OpenRouter. Absent ⇒ BYOK: no override (Zai GLM, unchanged).
  endpointBaseUrl?: string;
}

export interface OpencodeEventTelemetry {
  rawEventCount: number;
  tokenUsage?: TokenUsage;
  usageLimit?: UsageLimitSignal;
  // The OpenRouter generation id, when a managed (OpenRouter-routed) run surfaced
  // one. Folded onto tokenUsage so the recorder can query the REAL `usage.cost`.
  openRouterGenerationId?: string;
  // Count of lines that LOOK like JSON (leading `{`) but failed to parse. opencode's
  // `--print-logs` interleaves human log text with JSON events, so a plain-text line
  // is BENIGN (not counted); only a JSON-shaped-but-malformed line is contract drift
  // (silent-fallback hardening: no longer silently skipped).
  malformedLineCount?: number;
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
        managed: dependencies.endpointBaseUrl !== undefined,
      });
      const baselineSha = await captureBaselineSha(dependencies.ssh, dependencies.target, opts.workspace);
      const opencode = await dependencies.ssh.run(dependencies.target, {
        command: buildOpencodeWriterCommand({
          dataHome: auth.XDG_DATA_HOME,
          workspace: opts.workspace,
          model: resolveOpencodeModel(dependencies.model, auth.managed),
          configHome: auth.XDG_CONFIG_HOME,
        }),
        stdin: opts.prompt,
        // AGENT exec: opencode streams telemetry continuously (every line is a sign of
        // life → the watchdog resets), with the workspace as the silent-stretch
        // liveness probe. NEVER killed for elapsed time.
        watchdog: buildActivityWatchdog({
          substrate: dependencies.ssh,
          target: dependencies.target,
          cls: "agent",
          workspace: opts.workspace,
        }),
      });
      const telemetry = parseOpencodeStreamTelemetry(opencode.stdout);
      const gitState = await captureGitStateAfterWriter(
        dependencies.ssh,
        dependencies.target,
        opts.workspace,
        baselineSha,
        "opencode writer",
      );
      if (opencode.stalled === true) {
        return failedResult("timeout", telemetry, gitState);
      }
      if (telemetry.usageLimit !== undefined) {
        return failedResult("window_exhausted", telemetry, gitState);
      }
      if (opencode.failure !== undefined || opencode.exitCode !== 0) {
        return failedResult("crashed", telemetry, gitState);
      }
      return { ...gitState, exitReason: "completed", tokenUsage: telemetry.tokenUsage, telemetry };
    },
  };
}

// opencode reads the prompt on stdin and writes the run to the workspace. We
// point XDG_DATA_HOME at the per-run data dir (where the materialized auth.json
// lives), pin the model, and run with the workspace as the project directory.
// `--print-logs` emits the structured event stream we parse telemetry from.
export function buildOpencodeWriterCommand(input: {
  dataHome: string;
  workspace: string;
  model: string;
  // SaaS Tier-B #5: the config home holding the managed `opencode.json`. Set ⇒
  // managed run; we export XDG_CONFIG_HOME so opencode reads the OpenRouter
  // provider config. Absent ⇒ BYOK (unchanged).
  configHome?: string;
}): string {
  return [
    `XDG_DATA_HOME=${quoteSshShellArg(input.dataHome)}`,
    ...opencodeConfigHomeEnv(input.configHome),
    "opencode",
    "run",
    "--print-logs",
    "--model",
    quoteSshShellArg(input.model),
    "--cwd",
    quoteSshShellArg(input.workspace),
    "-",
  ].join(" ");
}

// SaaS Tier-B #5 (OpenRouter cookbook): a managed run reads its `opencode.json`
// OpenRouter provider config from the per-run config home (XDG_CONFIG_HOME).
// BYOK ⇒ no override (unchanged).
function opencodeConfigHomeEnv(configHome?: string): string[] {
  return configHome === undefined ? [] : [`XDG_CONFIG_HOME=${quoteSshShellArg(configHome)}`];
}

// SaaS Tier-B #5 (OpenRouter cookbook): a managed opencode run selects the
// openrouter provider. The chain's model is namespaced under that provider as
// `openrouter/<slug>` unless it already carries an `openrouter/` prefix. BYOK ⇒
// the chain model (default ZAI_GLM_MODEL), unchanged.
export function resolveOpencodeModel(model: string | undefined, managed: boolean): string {
  if (!managed) {
    return model ?? ZAI_GLM_MODEL;
  }
  const slug = model ?? ZAI_GLM_MODEL;
  return slug.startsWith("openrouter/") ? slug : `openrouter/${slug}`;
}

// Parses opencode's `--print-logs` output: one JSON object per line. Token
// usage lives under a `usage`/`tokens` object on a completion event; a
// usage-limit error surfaces as an `error` event carrying the stable "usage
// limit" phrase (matched on the phrase, not the event type, so a minor CLI
// wording change still surfaces it).
export function parseOpencodeStreamTelemetry(stdout: string): OpencodeEventTelemetry {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.trim() !== "");
  let tokenUsage: TokenUsage | undefined;
  let usageLimit: UsageLimitSignal | undefined;
  let openRouterGenerationId: string | undefined;
  // `--print-logs` interleaves human log text with JSON events. A plain-text line
  // is BENIGN; only a JSON-shaped line (leading `{`) that fails to parse is contract
  // drift — count THOSE so a malformed event line is no longer silently skipped.
  let malformedLineCount = 0;
  for (const line of lines) {
    const parsed = parseJsonObject(line);
    if (parsed === undefined) {
      if (line.trimStart().startsWith("{")) {
        malformedLineCount += 1;
      }
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

function detectUsageLimit(event: Record<string, unknown>): UsageLimitSignal | undefined {
  const candidates: unknown[] = [event["message"], event["error"]];
  const errorField = event["error"];
  if (typeof errorField === "object" && errorField !== null && !Array.isArray(errorField)) {
    candidates.push((errorField as Record<string, unknown>)["message"]);
  }
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /usage limit|rate limit/iu.test(candidate)) {
      return { message: candidate };
    }
  }
  return undefined;
}

// Walks one parsed opencode JSONL event for its usage record. BOUNDED on depth +
// node count (a hostile/buggy deeply-nested event must not blow the stack); on
// hitting a bound it emits a LOUD `usage-parse-bounded` signal rather than
// silently dropping usage. The opencode disjoint shape is `tokenUsageFromRecord`.
function findTokenUsage(value: unknown): TokenUsage | undefined {
  return findTokenUsageBounded("opencode", value, tokenUsageFromRecord);
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
  const cacheCreationTokens =
    numberField(record, ["cache_write_input_tokens", "cache_write", "cacheCreationTokens"]) ?? 0;
  const reasoningOutputTokens =
    numberField(record, ["reasoning_output_tokens", "reasoning", "reasoningOutputTokens"]) ?? 0;
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

function failedResult(
  exitReason: "timeout" | "crashed" | "window_exhausted",
  telemetry: OpencodeEventTelemetry,
  gitState: Pick<WriterResult, "diff" | "commits">,
): WriterResult {
  return { ...gitState, exitReason, tokenUsage: telemetry.tokenUsage, telemetry };
}

// Re-export so callers can persist a refreshed opencode auth bundle the same
// way the Codex/Claude paths do (best-effort write-back lives in the workflow).
export { storeOpencodeAuthBundle };
