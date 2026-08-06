import type { RunnerHandle } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import { validateCredentialRef } from "../credentials/codexAuth.js";
import { quoteSshShellArg } from "../ssh/command.js";
import type { TokenUsage, UsageLimitSignal, WriterAdapter, WriterResult } from "./types.js";
import { captureBaselineSha, captureGitStateAfterWriter } from "./writerGit.js";
import { buildActivityWatchdog } from "../ssh/activityWatchdog.js";

// aider harness adapter — a Writer-only CLI harness conforming to the v1
// harness protocol (docs/architecture/harness-protocol.md). aider has NO
// structured-JSON output channel, so it is writer-only (like opencode); the
// capability table (harnessCapability.ts) rejects aider-as-answerer.
//
// aider drives an underlying LLM (Anthropic/OpenAI/etc.). We run it
// non-interactively over SSH in the workspace, let it edit + commit, then
// derive the WriterResult from git state (shared writerGit helpers, same as
// the Claude/opencode writers).
//
// Invocation contract (aider's documented batch flags):
//   aider --yes-always --no-stream --no-check-update \
//         --no-auto-commits=false (i.e. let aider commit) \
//         --model <model> --message <prompt>
// Notes / assumptions:
//   * `--yes-always` answers every confirmation prompt with "yes" so the run
//     is fully non-interactive (aider's documented batch flag; older builds
//     spelled it `--yes`).
//   * `--message <prompt>` runs a single instruction then exits (aider's
//     documented one-shot/batch mode).
//   * We let aider make its own git commits (its default `--auto-commits`),
//     then ALSO run the shared commit/diff capture to fold in any
//     uncommitted residue and produce the unified diff vs. the baseline. This
//     matches the opencode/Claude writers, which capture git state after the
//     CLI exits regardless of whether the CLI committed.
//   * aider does not emit a machine-readable token-usage stream in v1 of this
//     adapter. We best-effort scrape its human-readable "Tokens: …" summary
//     line; when absent, tokenUsage is omitted (the orchestrator treats this
//     as emptyTokenUsage). Deferred(aider-telemetry): adopt aider's structured
//     usage output if/when a stable machine-readable form is documented.

// The env var aider reads the underlying-LLM API key from depends on the
// provider the pinned model belongs to. aider follows the LiteLLM convention
// (model id is `provider/model` or a bare OpenAI/Anthropic name). We resolve
// the relevant var from the model id so the SAME credential-ref mechanism
// (a raw API key in the secret store) works across providers.
const DEFAULT_AIDER_MODEL = "anthropic/claude-opus-4-8";

export interface AiderWriterDependencies {
  secrets: SecretStore;
  ssh: CommandSubstrate;
  target: RunnerHandle;
  credentialRef: string;
  runId: string;
  // The aider model id this adapter pins (e.g. "anthropic/claude-opus-4-8",
  // "gpt-5", "openai/gpt-5"). Defaults to DEFAULT_AIDER_MODEL.
  model?: string;
  // SaaS Tier-B #5: optional OpenAI-compatible base URL. When the run resolves
  // a MANAGED credential (the platform OpenRouter key), this is the OpenRouter
  // endpoint; aider is pointed at it via `--openai-api-base` and the key is
  // injected as OPENAI_API_KEY (OpenRouter is OpenAI-API-compatible). Absent ⇒
  // BYOK: no override, aider uses the provider's native endpoint (unchanged).
  endpointBaseUrl?: string;
}

export interface AiderTelemetry {
  rawEventCount: number;
  tokenUsage?: TokenUsage;
  usageLimit?: UsageLimitSignal;
}

export function createAiderWriter(dependencies: AiderWriterDependencies): WriterAdapter {
  return {
    kind: "writer",
    cli: "aider",
    authRef: dependencies.credentialRef,
    // The id `runWriter` below pins on the command line — the recorder writes THIS
    // to `cost_records.model` and the notional source looks it up. Resolved here,
    // not just inside the closure, because the closure's value never leaves it.
    model: dependencies.model ?? DEFAULT_AIDER_MODEL,
    async runWriter(opts): Promise<WriterResult> {
      const model = dependencies.model ?? DEFAULT_AIDER_MODEL;
      const apiKey = await resolveAiderApiKey(dependencies.secrets, dependencies.credentialRef);
      const baselineSha = await captureBaselineSha(dependencies.ssh, dependencies.target, opts.workspace);
      // Managed (endpoint override present) → the platform key is an OpenRouter
      // (OpenAI-compatible) key, read from OPENAI_API_KEY. BYOK → the
      // provider-specific var derived from the pinned model.
      const apiKeyEnvVar = dependencies.endpointBaseUrl === undefined ? apiKeyEnvVarForModel(model) : "OPENAI_API_KEY";
      const aider = await dependencies.ssh.run(dependencies.target, {
        command: buildAiderWriterCommand({
          apiKeyEnvVar,
          model,
          prompt: opts.prompt,
          runId: dependencies.runId,
          openaiApiBase: dependencies.endpointBaseUrl,
        }),
        // The API key rides stdin into a chmod-600 per-run env file (see
        // buildAiderWriterCommand) — it is NEVER interpolated into the command
        // string, so it can't leak into `ps`/process listings or logs.
        stdin: `export ${apiKeyEnvVar}=${shellSingleQuoteAider(apiKey)}\n`,
        cwd: opts.workspace,
        // AGENT exec: aider streams its edit/telemetry output continuously (every line
        // is a sign of life → the watchdog resets), with the workspace as the
        // silent-stretch liveness probe. NEVER killed for elapsed time.
        // `onWatchdogProgress` (task #24, apex v52/v53) is the cross-layer
        // sign-of-life bridge: every advancing tick emits a `writer.subtask.progress`
        // row so any parent progress reader sees the writer still advancing.
        // Composes with the substrate-internal `MIN_NON_ADVANCING_NEIGHBOR_REPEATS_*`
        // streak floor (see ssh/watchdogProgress.ts) — a wedge fires only after N
        // consecutive identical-neighbor probe pairs, never on elapsed time.
        watchdog: buildActivityWatchdog({
          substrate: dependencies.ssh,
          target: dependencies.target,
          cls: "agent",
          workspace: opts.workspace,
          onProgress: opts.onWatchdogProgress,
        }),
      });
      const telemetry = parseAiderTelemetry(aider.stdout + "\n" + aider.stderr);
      const gitState = await captureGitStateAfterWriter(
        dependencies.ssh,
        dependencies.target,
        opts.workspace,
        baselineSha,
        "aider writer",
      );
      if (aider.stalled === true) {
        return failedResult("timeout", telemetry, gitState);
      }
      if (telemetry.usageLimit !== undefined) {
        return failedResult("window_exhausted", telemetry, gitState);
      }
      if (aider.failure !== undefined || aider.exitCode !== 0) {
        return failedResult("crashed", telemetry, gitState);
      }
      return { ...gitState, exitReason: "completed", tokenUsage: telemetry.tokenUsage, telemetry };
    },
  };
}

// Resolves the underlying-LLM API key for the aider run from the secret store
// via the chain entry's authRef (same managed-ref mechanism as the other
// harnesses). The stored secret IS the raw API key string aider passes to its
// LLM provider.
export async function resolveAiderApiKey(secrets: SecretStore, ref: string): Promise<string> {
  const validated = validateCredentialRef(ref);
  const secret = await secrets.get(validated);
  if (secret === undefined) {
    throw new Error(`missing aider credential ref: ${validated}`);
  }
  if (secret.value.trim() === "") {
    throw new Error(`aider credential ref ${validated} resolved to an empty api key`);
  }
  return secret.value;
}

// aider reads the LLM API key from a provider-specific env var. We map the
// pinned model's provider prefix to that var (LiteLLM/aider convention). A
// bare `gpt-*`/`o*` name is OpenAI; everything else defaults to Anthropic,
// which is the project's primary writer model family.
export function apiKeyEnvVarForModel(model: string): string {
  const lower = model.toLowerCase();
  if (lower.startsWith("openai/") || lower.startsWith("gpt-") || lower.startsWith("o1") || lower.startsWith("o3")) {
    return "OPENAI_API_KEY";
  }
  if (lower.startsWith("gemini/") || lower.startsWith("gemini-")) {
    return "GEMINI_API_KEY";
  }
  // Default: Anthropic (anthropic/*, claude-*). aider reads ANTHROPIC_API_KEY.
  return "ANTHROPIC_API_KEY";
}

// The per-run env file the aider command sources for the provider API key.
// The key VALUE lives ONLY in this chmod-600 file (written from stdin), never
// in the command string.
export function aiderKeyEnvPath(runId: string): string {
  return `/tmp/tanren-aider-${runId}.env`;
}

// Builds the non-interactive aider invocation. SECURITY: the API key is NOT
// interpolated into the command string (that would leak it into `ps`/process
// listings and any log capturing the command). Instead the command reads the
// `export <VAR>=<key>` line from stdin into a chmod-600 per-run env file, then
// sources it before invoking aider — the exact env-file pattern the codex
// adapter uses. The workspace is the cwd (RunnerCommand.cwd cd's into it), so
// aider operates on the run's git repo.
export function buildAiderWriterCommand(input: {
  apiKeyEnvVar: string;
  model: string;
  prompt: string;
  runId: string;
  // SaaS Tier-B #5: when set (managed mode), aider is pointed at this
  // OpenAI-compatible base URL via `--openai-api-base` (OpenRouter endpoint).
  // Absent ⇒ BYOK: no flag, aider hits the provider's native endpoint.
  openaiApiBase?: string;
}): string {
  const envPath = aiderKeyEnvPath(input.runId);
  const aider = [
    "aider",
    "--yes-always",
    "--no-stream",
    "--no-check-update",
    "--no-gui",
    "--model",
    quoteSshShellArg(input.model),
    ...(input.openaiApiBase === undefined ? [] : ["--openai-api-base", quoteSshShellArg(input.openaiApiBase)]),
    "--message",
    quoteSshShellArg(input.prompt),
  ].join(" ");
  // umask 077 + explicit chmod 600 so the key file is never world/group-readable.
  // The `export …=…` line arrives on stdin (never the argv). `set -a` while
  // sourcing marks the exported var for the aider child; a `rm -f` trap wipes the
  // key file on any exit path.
  return [
    "umask 077",
    `cat > ${quoteSshShellArg(envPath)}`,
    `chmod 600 ${quoteSshShellArg(envPath)}`,
    `trap ${quoteSshShellArg(`rm -f ${envPath}`)} EXIT`,
    `. ${quoteSshShellArg(envPath)}`,
    aider,
  ].join(" && ");
}

// POSIX single-quote escaping for the stdin `export` line. Wrap in single
// quotes, replacing any embedded single quote with the '\'' sequence.
function shellSingleQuoteAider(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// aider does not emit a structured event stream in v1 of this adapter. We
// best-effort scrape:
//   * a usage-limit signal from the stable "rate limit"/"usage limit" phrasing
//     aider surfaces when the underlying provider rejects on quota, and
//   * a token-usage summary from aider's human-readable "Tokens: <in> sent,
//     <out> received" line, when present.
export function parseAiderTelemetry(output: string): AiderTelemetry {
  const lines = output.split(/\r?\n/u).filter((line) => line.trim() !== "");
  let usageLimit: UsageLimitSignal | undefined;
  for (const line of lines) {
    if (/usage limit|rate limit/iu.test(line)) {
      usageLimit = { message: line.trim() };
    }
  }
  return { rawEventCount: lines.length, tokenUsage: parseAiderTokenUsage(output), usageLimit };
}

// Matches aider's "Tokens: 1,234 sent, 567 received" summary line. Buckets are
// disjoint (sent ⇒ input, received ⇒ output); aider does not break out cache
// or reasoning tokens, so those stay 0. Returns undefined when no such line is
// present.
function parseAiderTokenUsage(output: string): TokenUsage | undefined {
  const match = /Tokens:\s*([\d,]+)\s*sent,\s*([\d,]+)\s*received/iu.exec(output);
  if (match === null) {
    return undefined;
  }
  const inputTokens = parseCount(match[1]);
  const outputTokens = parseCount(match[2]);
  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined;
  }
  return {
    inputTokens,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: inputTokens + outputTokens,
  };
}

function parseCount(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw.replaceAll(",", ""));
  return Number.isFinite(value) ? value : undefined;
}

function failedResult(
  exitReason: "timeout" | "crashed" | "window_exhausted",
  telemetry: AiderTelemetry,
  gitState: Pick<WriterResult, "diff" | "commits">,
): WriterResult {
  return { ...gitState, exitReason, tokenUsage: telemetry.tokenUsage, telemetry };
}
