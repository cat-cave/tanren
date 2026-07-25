import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { createClaudeWriter } from "../src/engine/providers/claude.js";
import { createCodexWriter } from "../src/engine/providers/codex.js";
import { createOpencodeWriter } from "../src/engine/providers/opencode.js";
import { createReasonixWriter } from "../src/engine/providers/reasonix.js";
import type { WriterAdapter } from "../src/engine/providers/types.js";
const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};
const providers = ["claude", "codex", "opencode", "reasonix"] as const;
type Provider = (typeof providers)[number];
describe("JSONL writer post-processing failures", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());
  it.each(providers)("%s preserves typed failure and proven cost across git failure", async (provider) => {
    const { adapter, secrets } = await buildCase(provider);
    const result = await adapter.runWriter({ prompt: "write", workspace: "/workspace/repo" });
    expect(result).toMatchObject({
      diff: "",
      commits: [],
      exitReason: "crashed",
      tokenUsage: { inputTokens: 7, outputTokens: 4, totalTokens: 11 },
      telemetry: {
        rawEventCount: 3,
        jsonlDecodeFailure: {
          kind: "jsonl_object_decode_failed",
          failures: [{ lineNumber: 2, reason: "invalid_json" }],
        },
      },
    });
    expect(JSON.stringify([result, errorSpy.mock.calls])).not.toContain(secrets);
    expect(errorSpy).toHaveBeenCalledOnce();
  });
});
async function buildCase(provider: Provider) {
  const store = new InMemorySecretStore();
  const authSecret = `${provider}-auth-secret`;
  const captureSecret = `${provider}-capture-secret`;
  const ref = `credential/${provider}/dev`;
  const auth =
    provider === "claude"
      ? JSON.stringify({ claudeAiOauth: { accessToken: authSecret, refreshToken: "refresh" } })
      : provider === "codex"
        ? JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: authSecret, refresh_token: "refresh" } })
        : provider === "opencode"
          ? JSON.stringify({ zai: { key: authSecret } })
          : authSecret;
  await store.put({ ref, value: auth });
  const results = [
    ...(provider === "reasonix" ? [] : [ok("")]),
    ok(`${"b".repeat(40)}\n`),
    ok(usageStream(provider)),
    ...(provider === "codex" ? [ok(auth)] : []),
    { exitCode: 1, stdout: "", stderr: `git capture failed: ${captureSecret}` },
  ];
  const ssh = new ScriptedSsh(results);
  const deps = { secrets: store, ssh, target, credentialRef: ref, runId: `run_${provider}` };
  const adapter: WriterAdapter =
    provider === "claude"
      ? createClaudeWriter(deps)
      : provider === "codex"
        ? createCodexWriter(deps)
        : provider === "opencode"
          ? createOpencodeWriter(deps)
          : createReasonixWriter(deps);
  return { adapter, secrets: `${authSecret}|${captureSecret}` };
}
function usageStream(provider: Provider): string {
  const usage =
    provider === "codex"
      ? (input: number, output: number) => ({ promptTokens: input, completionTokens: output })
      : provider === "reasonix"
        ? (input: number, output: number) => ({ prompt_tokens: input, completion_tokens: output })
        : (input: number, output: number) => ({ input_tokens: input, output_tokens: output });
  return `${JSON.stringify({ usage: usage(2, 1) })}\nnot-json\n${JSON.stringify({ usage: usage(7, 4) })}\n`;
}
function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}
class ScriptedSsh implements CommandSubstrate {
  constructor(private readonly results: CommandResult[]) {}
  async run(_sshTarget: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    const result = this.results.shift();
    if (result === undefined) throw new Error(`unexpected SSH command: ${command.command}`);
    return result;
  }
}
