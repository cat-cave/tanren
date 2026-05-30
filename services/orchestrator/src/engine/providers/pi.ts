import type { SshTarget } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { SshSubstrate } from "../contracts/sshSubstrate.js";
import { validateCredentialRef } from "../credentials/codexAuth.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { apiKeyEnvVarForModel } from "./aider.js";
import type { TokenUsage, UsageLimitSignal, WriterAdapter, WriterResult } from "./types.js";
import { captureBaselineSha, captureGitStateAfterWriter } from "./writerGit.js";

// pi harness adapter (`@earendil-works/pi-coding-agent`) — a Writer-only CLI
// harness conforming to the v1 harness protocol
// (docs/architecture/harness-protocol.md). pi has NO structured-JSON output
// channel, so it is writer-only (like opencode/aider); the capability table
// (harnessCapability.ts) rejects pi-as-answerer.
//
// pi drives an underlying LLM via per-provider env-key auth. We run it
// non-interactively over SSH in the workspace, let it edit + commit, then
// derive the WriterResult from git state (shared writerGit helpers, same as
// the aider/opencode/Claude writers).
//
// Invocation contract (pi's documented non-interactive mode):
//   <PROVIDER_API_KEY>=… pi -p "<prompt>"
// Notes / assumptions (spec-based — live validation is deferred, like aider):
//   * `-p "<prompt>"` is pi's documented one-shot/headless mode (prompt may
//     alternatively be delivered on stdin); the process runs the single
//     instruction then exits.
//   * Auth is per-provider via an env key (e.g. ANTHROPIC_API_KEY). We resolve
//     the relevant var from the pinned model id, reusing aider's
//     apiKeyEnvVarForModel mapping (LiteLLM/aider convention), so the SAME raw
//     API-key credential-ref mechanism works across providers.
//   * pi makes its own git commits in the workspace; we ALSO run the shared
//     commit/diff capture to fold in any uncommitted residue and produce the
//     unified diff vs. the baseline (same as the aider/opencode writers).
//   * pi does not expose a documented machine-readable token-usage stream in
//     v1 of this adapter. We best-effort scrape a human-readable token summary;
//     when absent, tokenUsage is omitted (treated as emptyTokenUsage).
//     Deferred(pi-telemetry): adopt pi's structured usage output if/when a stable
//     machine-readable form is documented.

const DEFAULT_PI_MODEL = "anthropic/claude-opus-4-8";

export interface PiWriterDependencies {
  secrets: SecretStore;
  ssh: SshSubstrate;
  target: SshTarget;
  credentialRef: string;
  runId: string;
  // The pi model id this adapter pins (e.g. "anthropic/claude-opus-4-8",
  // "openai/gpt-5"). Defaults to DEFAULT_PI_MODEL. The model id selects which
  // per-provider env key carries the credential (apiKeyEnvVarForModel).
  model?: string;
  // SaaS Tier-B #5: optional OpenAI-compatible base URL. When the run resolves
  // a MANAGED credential (the platform OpenRouter key), this is the OpenRouter
  // endpoint; pi is pointed at it via OPENAI_BASE_URL and the key is injected as
  // OPENAI_API_KEY (OpenRouter is OpenAI-API-compatible). Absent ⇒ BYOK: no
  // override, pi uses the provider's native endpoint (unchanged).
  endpointBaseUrl?: string;
}

export interface PiTelemetry {
  rawEventCount: number;
  tokenUsage?: TokenUsage;
  usageLimit?: UsageLimitSignal;
}

export function createPiWriter(dependencies: PiWriterDependencies): WriterAdapter {
  return {
    kind: "writer",
    cli: "pi",
    authRef: dependencies.credentialRef,
    async runWriter(opts): Promise<WriterResult> {
      const model = dependencies.model ?? DEFAULT_PI_MODEL;
      const apiKey = await resolvePiApiKey(dependencies.secrets, dependencies.credentialRef);
      const baselineSha = await captureBaselineSha(
        dependencies.ssh,
        dependencies.target,
        opts.workspace,
        opts.timeoutMs,
      );
      const pi = await dependencies.ssh.run(dependencies.target, {
        command: buildPiWriterCommand({
          // Managed (endpoint override present) → the platform key is an
          // OpenRouter (OpenAI-compatible) key, read from OPENAI_API_KEY. BYOK →
          // the provider-specific var derived from the pinned model.
          apiKeyEnvVar: dependencies.endpointBaseUrl === undefined ? apiKeyEnvVarForModel(model) : "OPENAI_API_KEY",
          apiKey,
          prompt: opts.prompt,
          endpointBaseUrl: dependencies.endpointBaseUrl,
        }),
        cwd: opts.workspace,
        timeoutMs: opts.timeoutMs,
      });
      const telemetry = parsePiTelemetry(pi.stdout + "\n" + pi.stderr);
      const gitState = await captureGitStateAfterWriter(
        dependencies.ssh,
        dependencies.target,
        opts.workspace,
        baselineSha,
        "pi writer",
        opts.timeoutMs,
      );
      if (pi.timedOut) {
        return failedResult("timeout", telemetry, gitState);
      }
      if (telemetry.usageLimit !== undefined) {
        return failedResult("window_exhausted", telemetry, gitState);
      }
      if (pi.failure !== undefined || pi.exitCode !== 0) {
        return failedResult("crashed", telemetry, gitState);
      }
      return { ...gitState, exitReason: "completed", tokenUsage: telemetry.tokenUsage, telemetry };
    },
  };
}

// Resolves the underlying-LLM API key for the pi run from the secret store via
// the chain entry's authRef (same managed-ref mechanism as the other
// harnesses). The stored secret IS the raw API key string pi passes to its LLM
// provider.
export async function resolvePiApiKey(secrets: SecretStore, ref: string): Promise<string> {
  const validated = validateCredentialRef(ref);
  const secret = await secrets.get(validated);
  if (secret === undefined) {
    throw new Error(`missing pi credential ref: ${validated}`);
  }
  if (secret.value.trim() === "") {
    throw new Error(`pi credential ref ${validated} resolved to an empty api key`);
  }
  return secret.value;
}

// Builds the non-interactive pi invocation. The API key is injected as a
// command-scoped env var (provider-specific) so it never lands in a file and is
// redacted from the adapter's own result. The workspace is the cwd (the
// SshCommand.cwd cd's into it), so pi operates on the run's git repo.
export function buildPiWriterCommand(input: {
  apiKeyEnvVar: string;
  apiKey: string;
  prompt: string;
  // SaaS Tier-B #5: when set (managed mode), pi is pointed at this
  // OpenAI-compatible base URL via OPENAI_BASE_URL (OpenRouter endpoint). Absent
  // ⇒ BYOK: no override, pi hits the provider's native endpoint.
  endpointBaseUrl?: string;
}): string {
  return [
    `${input.apiKeyEnvVar}=${quoteSshShellArg(input.apiKey)}`,
    ...(input.endpointBaseUrl === undefined ? [] : [`OPENAI_BASE_URL=${quoteSshShellArg(input.endpointBaseUrl)}`]),
    "pi",
    "-p",
    quoteSshShellArg(input.prompt),
  ].join(" ");
}

// pi does not emit a documented structured event stream in v1 of this adapter.
// We best-effort scrape:
//   * a usage-limit signal from the stable "rate limit"/"usage limit" phrasing
//     surfaced when the underlying provider rejects on quota, and
//   * a token-usage summary from a human-readable "Tokens: <in> sent,
//     <out> received" line, when present.
export function parsePiTelemetry(output: string): PiTelemetry {
  const lines = output.split(/\r?\n/u).filter((line) => line.trim() !== "");
  let usageLimit: UsageLimitSignal | undefined;
  for (const line of lines) {
    if (/usage limit|rate limit/iu.test(line)) {
      usageLimit = { message: line.trim() };
    }
  }
  return { rawEventCount: lines.length, tokenUsage: parsePiTokenUsage(output), usageLimit };
}

// Matches a "Tokens: 1,234 sent, 567 received" summary line. Buckets are
// disjoint (sent ⇒ input, received ⇒ output); pi does not break out cache or
// reasoning tokens, so those stay 0. Returns undefined when no such line is
// present.
function parsePiTokenUsage(output: string): TokenUsage | undefined {
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
  telemetry: PiTelemetry,
  gitState: Pick<WriterResult, "diff" | "commits">,
): WriterResult {
  return { ...gitState, exitReason, tokenUsage: telemetry.tokenUsage, telemetry };
}
