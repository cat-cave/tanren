import type { RunnerHandle } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import { validateCredentialRef } from "../credentials/codexAuth.js";
import { quoteSshShellArg } from "../ssh/command.js";
import type { JsonlObjectDecodeFailure, TokenUsage, UsageLimitSignal, WriterAdapter, WriterResult } from "./types.js";
import { captureBaselineSha, captureGitStateAfterWriter, postProcessPreservingJsonlFailure } from "./writerGit.js";
import { buildActivityWatchdog } from "../ssh/activityWatchdog.js";
import { decodeJsonlObjectEvents, findTokenUsageBounded } from "./findTokenUsage.js";

// reasonix harness adapter (DeepSeek-native, npm `reasonix`) — a Writer-only
// CLI harness conforming to the v1 harness protocol
// (docs/architecture/harness-protocol.md). reasonix has NO schema-constrained
// answer output channel, so it is writer-only (like opencode/aider/pi); the
// capability table (harnessCapability.ts) rejects reasonix-as-answerer.
//
// reasonix drives DeepSeek and authenticates from a single DEEPSEEK_API_KEY env
// var. We run it non-interactively over SSH in the workspace, let it edit +
// commit, then derive the WriterResult from git state (shared writerGit
// helpers, same as the aider/opencode/pi/Claude writers).
//
// Invocation contract (reasonix's documented headless mode):
//   DEEPSEEK_API_KEY=… reasonix run "<task>"
// Notes / assumptions (spec-based — live validation is deferred, like aider):
//   * `run "<task>"` is reasonix's documented headless subcommand; the process
//     runs the single task then exits.
//   * Auth is DeepSeek-native: the raw API key is injected as DEEPSEEK_API_KEY.
//     reasonix is DeepSeek-only, so (unlike aider/pi) there is no per-model env
//     var to resolve.
//   * reasonix makes its own git commits in the workspace; we ALSO run the
//     shared commit/diff capture to fold in any uncommitted residue and produce
//     the unified diff vs. the baseline (same as the other writers).
//   * reasonix emits NDJSON/transcript telemetry on stdout. We parse it the same
//     way opencode parses its JSON stream: token usage from a usage/tokens
//     object, and a usage-limit signal from the stable "usage limit"/"rate
//     limit" phrasing. NDJSON has no schema-constrained ANSWER channel, so this
//     telemetry does not make reasonix Answerer-eligible.

// The DeepSeek env var reasonix reads its API key from. reasonix is
// DeepSeek-native, so this is fixed (no per-model resolution).
export const REASONIX_API_KEY_ENV_VAR = "DEEPSEEK_API_KEY";

export interface ReasonixWriterDependencies {
  secrets: SecretStore;
  ssh: CommandSubstrate;
  target: RunnerHandle;
  credentialRef: string;
  runId: string;
  // The reasonix/DeepSeek model id this adapter pins (e.g. "deepseek-reasoner").
  // Optional: when present it is passed via `--model`; absent ⇒ reasonix's
  // default DeepSeek model.
  model?: string;
}

export interface ReasonixEventTelemetry {
  rawEventCount: number;
  tokenUsage?: TokenUsage;
  usageLimit?: UsageLimitSignal;
  jsonlDecodeFailure?: JsonlObjectDecodeFailure;
}

export function createReasonixWriter(dependencies: ReasonixWriterDependencies): WriterAdapter {
  return {
    kind: "writer",
    cli: "reasonix",
    authRef: dependencies.credentialRef,
    // Forwarded EXACTLY as declared, absent included: with no pinned model reasonix
    // picks its own DeepSeek default, whose id tanren does not know. An absent model
    // records the honest `model_id_absent`; inventing an id here would record a
    // priced notional figure for a call that may not have used that model at all.
    ...(dependencies.model !== undefined && { model: dependencies.model }),
    async runWriter(opts): Promise<WriterResult> {
      const apiKey = await resolveReasonixApiKey(dependencies.secrets, dependencies.credentialRef);
      const baselineSha = await captureBaselineSha(dependencies.ssh, dependencies.target, opts.workspace);
      const reasonix = await dependencies.ssh.run(dependencies.target, {
        command: buildReasonixWriterCommand({
          apiKey,
          task: opts.prompt,
          model: dependencies.model,
        }),
        cwd: opts.workspace,
        // AGENT exec: reasonix streams its output continuously (every line is a sign of
        // life → the watchdog resets), with the workspace as the silent-stretch
        // liveness probe. NEVER killed for elapsed time. `onWatchdogProgress` (task
        // #24) is the cross-layer sign-of-life bridge — every advancing tick emits
        // `writer.subtask.progress`; composes with the substrate's
        // `MIN_NON_ADVANCING_NEIGHBOR_REPEATS_*` streak floor (ssh/watchdogProgress.ts).
        watchdog: buildActivityWatchdog({
          substrate: dependencies.ssh,
          target: dependencies.target,
          cls: "agent",
          workspace: opts.workspace,
          onProgress: opts.onWatchdogProgress,
        }),
      });
      const telemetry = parseReasonixStreamTelemetry(reasonix.stdout);
      const gitState = await postProcessPreservingJsonlFailure("reasonix", telemetry, () =>
        captureGitStateAfterWriter(
          dependencies.ssh,
          dependencies.target,
          opts.workspace,
          baselineSha,
          "reasonix writer",
        ),
      );
      // Stall / usage-limit precedence over a JSONL decode failure (see claude.ts).
      if (reasonix.stalled === true) {
        return failedResult("timeout", telemetry, gitState);
      }
      if (telemetry.usageLimit !== undefined) {
        return failedResult("window_exhausted", telemetry, gitState);
      }
      if (telemetry.jsonlDecodeFailure !== undefined) {
        return failedResult("crashed", telemetry, gitState);
      }
      if (reasonix.failure !== undefined || reasonix.exitCode !== 0) {
        return failedResult("crashed", telemetry, gitState);
      }
      return { ...gitState, exitReason: "completed", tokenUsage: telemetry.tokenUsage, telemetry };
    },
  };
}

// Resolves the DeepSeek API key for the reasonix run from the secret store via
// the chain entry's authRef (same managed-ref mechanism as the other
// harnesses). The stored secret IS the raw DeepSeek API key string.
export async function resolveReasonixApiKey(secrets: SecretStore, ref: string): Promise<string> {
  const validated = validateCredentialRef(ref);
  const secret = await secrets.get(validated);
  if (secret === undefined) {
    throw new Error(`missing reasonix credential ref: ${validated}`);
  }
  if (secret.value.trim() === "") {
    throw new Error(`reasonix credential ref ${validated} resolved to an empty api key`);
  }
  return secret.value;
}

// Builds the non-interactive reasonix invocation. The DeepSeek API key is
// injected as a command-scoped DEEPSEEK_API_KEY env var so it never lands in a
// file and is redacted from the adapter's own result. The workspace is the cwd
// (the RunnerCommand.cwd cd's into it), so reasonix operates on the run's git repo.
export function buildReasonixWriterCommand(input: { apiKey: string; task: string; model?: string }): string {
  return [
    `${REASONIX_API_KEY_ENV_VAR}=${quoteSshShellArg(input.apiKey)}`,
    "reasonix",
    "run",
    ...(input.model === undefined ? [] : ["--model", quoteSshShellArg(input.model)]),
    quoteSshShellArg(input.task),
  ].join(" ");
}

// Parses reasonix's NDJSON telemetry: one JSON object per line. Token usage
// lives under a `usage`/`tokens` object on a completion event; a usage-limit
// error surfaces carrying the stable "usage limit"/"rate limit" phrase (matched
// on the phrase, not the event type, so a minor CLI wording change still
// surfaces it). Mirrors opencode's stream parser.
export function parseReasonixStreamTelemetry(stdout: string): ReasonixEventTelemetry {
  const decoded = decodeJsonlObjectEvents(stdout);
  let tokenUsage: TokenUsage | undefined;
  let usageLimit: UsageLimitSignal | undefined;
  for (const parsed of decoded.events) {
    tokenUsage = findTokenUsage(parsed) ?? tokenUsage;
    usageLimit = detectUsageLimit(parsed) ?? usageLimit;
  }
  const telemetry = { rawEventCount: decoded.rawEventCount, tokenUsage, usageLimit };
  return decoded.ok ? telemetry : { ...telemetry, jsonlDecodeFailure: decoded.failure };
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

// Walks one parsed reasonix JSONL event for its usage record. BOUNDED on depth +
// node count (a hostile/buggy deeply-nested event must not blow the stack); on
// hitting a bound it emits a LOUD `usage-parse-bounded` signal rather than
// silently dropping usage. The DeepSeek de-overlap shape is `tokenUsageFromRecord`.
function findTokenUsage(value: unknown): TokenUsage | undefined {
  return findTokenUsageBounded("reasonix", value, tokenUsageFromRecord);
}

// DeepSeek reports prompt/completion token counts plus a cache-hit bucket. We
// map cache-hit reads to cachedInputTokens (disjoint from the uncached
// inputTokens) so the buckets stay non-overlapping, matching the protocol's
// disjoint-bucket contract.
function tokenUsageFromRecord(record: Record<string, unknown>): TokenUsage | undefined {
  const promptTokens = numberField(record, ["input_tokens", "inputTokens", "input", "prompt_tokens"]);
  const outputTokens = numberField(record, ["output_tokens", "outputTokens", "output", "completion_tokens"]);
  if (promptTokens === undefined || outputTokens === undefined) {
    return undefined;
  }
  // DeepSeek's prompt_tokens is INCLUSIVE of cache hits; de-overlap so
  // inputTokens (uncached) + cachedInputTokens reconstruct the prompt total.
  const cachedInputTokens =
    numberField(record, ["prompt_cache_hit_tokens", "cache_read_input_tokens", "cache_read", "cachedInputTokens"]) ?? 0;
  const inputTokens = Math.max(promptTokens - cachedInputTokens, 0);
  const reasoningOutputTokens =
    numberField(record, ["reasoning_tokens", "reasoning_output_tokens", "reasoning", "reasoningOutputTokens"]) ?? 0;
  const totalTokens =
    numberField(record, ["total_tokens", "totalTokens"]) ??
    inputTokens + cachedInputTokens + outputTokens + reasoningOutputTokens;
  return {
    inputTokens,
    cachedInputTokens,
    cacheCreationTokens: 0,
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
  telemetry: ReasonixEventTelemetry,
  gitState: Pick<WriterResult, "diff" | "commits">,
): WriterResult {
  return { ...gitState, exitReason, tokenUsage: telemetry.tokenUsage, telemetry };
}
