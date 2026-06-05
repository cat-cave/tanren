import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import {
  apiKeyEnvVarForModel,
  buildAiderWriterCommand,
  createAiderWriter,
  parseAiderTelemetry,
} from "../src/engine/providers/aider.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

const apiKey = "sk-aider-secret-key";
const baselineSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("aider writer adapter", () => {
  it("runs aider non-interactively in the workspace, parses git state into a WriterResult", async () => {
    const ssh = new ScriptedSsh([
      // baseline sha
      ok(`${baselineSha}\n`),
      // aider run
      ok("Applied edit to Y.md\nTokens: 1,200 sent, 340 received\n"),
      // commit
      ok(""),
      // diff
      ok("diff --git a/Y.md b/Y.md\n+done\n"),
      // log
      ok(`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\taider writer\n`),
    ]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/aider/dev", value: apiKey });

    const writer = createAiderWriter({
      secrets,
      ssh,
      target,
      credentialRef: "credential/aider/dev",
      runId: "run_aider_1",
    });
    const result = await writer.runWriter({
      prompt: "make a tiny edit",
      workspace: "/workspace/repo",
      timeoutMs: 1000,
    });

    const aiderCommand = ssh.commands[1]?.command;
    expect(aiderCommand?.command).toContain("aider");
    expect(aiderCommand?.command).toContain("--yes-always");
    expect(aiderCommand?.command).toContain("--message 'make a tiny edit'");
    expect(aiderCommand?.command).toContain("--model 'anthropic/claude-opus-4-8'");
    expect(aiderCommand?.command).toContain("ANTHROPIC_API_KEY=");
    expect(aiderCommand?.cwd).toBe("/workspace/repo");
    expect(writer.cli).toBe("aider");
    expect(writer.authRef).toBe("credential/aider/dev");
    expect(result).toMatchObject({
      diff: "diff --git a/Y.md b/Y.md\n+done\n",
      exitReason: "completed",
      commits: [{ sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", message: "aider writer" }],
      tokenUsage: {
        inputTokens: 1200,
        outputTokens: 340,
        totalTokens: 1540,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        reasoningOutputTokens: 0,
      },
    });
  });

  it("resolves the underlying-LLM API key from the credential store via authRef", async () => {
    const ssh = new ScriptedSsh([ok(`${baselineSha}\n`), ok(""), ok(""), ok(""), ok("")]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/aider/dev", value: apiKey });
    const writer = createAiderWriter({
      secrets,
      ssh,
      target,
      credentialRef: "credential/aider/dev",
      runId: "run_aider_2",
    });
    await writer.runWriter({ prompt: "edit", workspace: "/workspace/repo", timeoutMs: 1000 });
    expect(ssh.commands[1]?.command.command).toContain(`ANTHROPIC_API_KEY='${apiKey}'`);
  });

  it("throws when the credential ref is missing", async () => {
    const ssh = new ScriptedSsh([ok(`${baselineSha}\n`)]);
    const writer = createAiderWriter({
      secrets: new InMemorySecretStore(),
      ssh,
      target,
      credentialRef: "credential/aider/absent",
      runId: "run_aider_3",
    });
    await expect(writer.runWriter({ prompt: "edit", workspace: "/workspace/repo", timeoutMs: 1000 })).rejects.toThrow(
      /missing aider credential ref/u,
    );
  });

  it("returns timeout, crashed, and window_exhausted distinctly", async () => {
    const timeout = await runWith({ exitCode: null, stdout: "", stderr: "", timedOut: true });
    const crashed = await runWith({ exitCode: 2, stdout: "", stderr: "boom", timedOut: false });
    const limit = await runWith({
      exitCode: 0,
      stdout: "Error: You have hit your rate limit, try again later.",
      stderr: "",
      timedOut: false,
    });
    expect(timeout.exitReason).toBe("timeout");
    expect(crashed.exitReason).toBe("crashed");
    expect(limit.exitReason).toBe("window_exhausted");
  });

  it("does not leak the API key through commands or results", async () => {
    const result = await runWith({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false });
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it("maps the model provider prefix to the right API-key env var", () => {
    expect(apiKeyEnvVarForModel("anthropic/claude-opus-4-8")).toBe("ANTHROPIC_API_KEY");
    expect(apiKeyEnvVarForModel("claude-opus-4-8")).toBe("ANTHROPIC_API_KEY");
    expect(apiKeyEnvVarForModel("openai/gpt-5")).toBe("OPENAI_API_KEY");
    expect(apiKeyEnvVarForModel("gpt-5")).toBe("OPENAI_API_KEY");
    expect(apiKeyEnvVarForModel("o3-mini")).toBe("OPENAI_API_KEY");
    expect(apiKeyEnvVarForModel("gemini/gemini-2.5-pro")).toBe("GEMINI_API_KEY");
  });

  it("builds a non-interactive batch command with the documented flags", () => {
    const command = buildAiderWriterCommand({
      apiKeyEnvVar: "ANTHROPIC_API_KEY",
      apiKey: "k",
      model: "anthropic/x",
      prompt: "do it",
    });
    expect(command).toContain("--yes-always");
    expect(command).toContain("--no-stream");
    expect(command).toContain("--message 'do it'");
  });

  // SaaS Tier-B #5: managed mode points aider at the OpenRouter endpoint with
  // the platform key via OPENAI_API_KEY. Asserts the COMMAND outcome, not mocks.
  it("points aider at the managed endpoint with the OpenAI key when an override is set", async () => {
    const ssh = new ScriptedSsh([ok(`${baselineSha}\n`), ok(""), ok(""), ok(""), ok("")]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/openrouter/platform/default", value: "or-platform-key" });
    const writer = createAiderWriter({
      secrets,
      ssh,
      target,
      credentialRef: "credential/openrouter/platform/default",
      runId: "run_aider_managed",
      endpointBaseUrl: "https://openrouter.ai/api/v1",
    });
    await writer.runWriter({ prompt: "edit", workspace: "/workspace/repo", timeoutMs: 1000 });
    const aiderCommand = ssh.commands[1]?.command.command ?? "";
    expect(aiderCommand).toContain("--openai-api-base 'https://openrouter.ai/api/v1'");
    expect(aiderCommand).toContain("OPENAI_API_KEY='or-platform-key'");
    expect(aiderCommand).not.toContain("ANTHROPIC_API_KEY=");
  });

  it("omits --openai-api-base for a BYOK run (no override)", () => {
    const command = buildAiderWriterCommand({
      apiKeyEnvVar: "ANTHROPIC_API_KEY",
      apiKey: "k",
      model: "anthropic/x",
      prompt: "do it",
    });
    expect(command).not.toContain("--openai-api-base");
  });

  it("adds --openai-api-base when an endpoint is passed to the command builder", () => {
    const command = buildAiderWriterCommand({
      apiKeyEnvVar: "OPENAI_API_KEY",
      apiKey: "k",
      model: "anthropic/x",
      prompt: "do it",
      openaiApiBase: "https://openrouter.ai/api/v1",
    });
    expect(command).toContain("--openai-api-base 'https://openrouter.ai/api/v1'");
  });

  it("scrapes aider's human-readable token summary into disjoint buckets", () => {
    const telemetry = parseAiderTelemetry("Applied edit\nTokens: 2,500 sent, 800 received\n");
    expect(telemetry.tokenUsage).toEqual({
      inputTokens: 2500,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 800,
      reasoningOutputTokens: 0,
      totalTokens: 3300,
    });
  });

  it("omits token usage when aider reports no summary line", () => {
    expect(parseAiderTelemetry("Applied edit to Y.md\n").tokenUsage).toBeUndefined();
  });
});

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

async function runWith(aiderResult: CommandResult) {
  const ssh = new ScriptedSsh([ok(`${baselineSha}\n`), aiderResult, ok(""), ok(""), ok("")]);
  const secrets = new InMemorySecretStore();
  await secrets.put({ ref: "credential/aider/dev", value: apiKey });
  const writer = createAiderWriter({
    secrets,
    ssh,
    target,
    credentialRef: "credential/aider/dev",
    runId: "run_aider_x",
  });
  return await writer.runWriter({ prompt: "write", workspace: "/workspace/repo", timeoutMs: 1000 });
}

class ScriptedSsh implements CommandSubstrate {
  readonly commands: Array<{ target: RunnerHandle; command: RunnerCommand }> = [];

  constructor(private readonly results: CommandResult[]) {}

  async run(sshTarget: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push({ target: sshTarget, command });
    const result = this.results.shift();
    if (result === undefined) {
      throw new Error(`unexpected SSH command: ${command.command}`);
    }
    return result;
  }
}
