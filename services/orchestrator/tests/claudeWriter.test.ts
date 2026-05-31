import { describe, expect, it } from "vitest";
import type { SshTarget } from "../src/engine/contracts/allocator.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import {
  buildClaudeWriterCommand,
  createClaudeWriter,
  parseClaudeStreamTelemetry,
} from "../src/engine/providers/claude.js";

const target: SshTarget = {
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

const authJson = JSON.stringify({
  claudeAiOauth: { accessToken: "secret-access-token", refreshToken: "secret-refresh-token" },
});

const baselineSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("Claude writer adapter", () => {
  it("constructs claude -p with per-run CLAUDE_CONFIG_DIR, model, workspace, and stdin prompt", async () => {
    const usageLine = JSON.stringify({
      type: "assistant",
      message: {
        usage: {
          input_tokens: 12,
          output_tokens: 5,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 2,
        },
      },
    });
    const ssh = new ScriptedSsh([
      // materialize auth
      ok(""),
      // capture baseline sha
      ok(`${baselineSha}\n`),
      // claude run
      ok(`${usageLine}\n`),
      // commit
      ok(""),
      // diff
      ok("diff --git a/X.md b/X.md\n+done\n"),
      // log
      ok(""),
    ]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/claude/dev", value: authJson });

    const writer = createClaudeWriter({
      secrets,
      ssh,
      target,
      credentialRef: "credential/claude/dev",
      runId: "run_claude_1",
      model: "claude-opus-4-8",
    });
    const result = await writer.runWriter({
      prompt: "make a tiny edit",
      workspace: "/workspace/repo",
      timeoutMs: 1000,
    });

    expect(ssh.commands[0]?.command.command).toContain("/run_claude_1/claude-home");
    expect(ssh.commands[0]?.command.stdin).toBe(authJson);
    expect(ssh.commands[2]?.command.command).toContain("claude -p");
    expect(ssh.commands[2]?.command.command).toContain("--output-format stream-json");
    expect(ssh.commands[2]?.command.command).toContain("--permission-mode acceptEdits");
    expect(ssh.commands[2]?.command.command).toContain("--model 'claude-opus-4-8'");
    expect(ssh.commands[2]?.command.stdin).toBe("make a tiny edit");
    expect(ssh.commands[3]?.command.command).toContain("git commit -m 'claude writer'");
    expect(result).toMatchObject({
      diff: "diff --git a/X.md b/X.md\n+done\n",
      commits: [],
      exitReason: "completed",
      tokenUsage: {
        inputTokens: 12,
        cachedInputTokens: 3,
        cacheCreationTokens: 2,
        outputTokens: 5,
        reasoningOutputTokens: 0,
        totalTokens: 22,
      },
    });
  });

  it("returns timeout and crashed without treating stdout as completion", async () => {
    const timeout = await runWithClaudeResult({
      exitCode: null,
      stdout: "{}\n",
      stderr: "",
      timedOut: true,
    });
    const crashed = await runWithClaudeResult({
      exitCode: 1,
      stdout: "{}\n",
      stderr: "bad",
      timedOut: false,
    });
    expect(timeout.exitReason).toBe("timeout");
    expect(crashed.exitReason).toBe("crashed");
  });

  it("returns window_exhausted (not crashed) when the account hits its usage limit", async () => {
    const usageLimit = '{"type":"result","result":"You have hit your usage limit. Try again at 8 PM."}';
    const result = await runWithClaudeResult({
      exitCode: 0,
      stdout: `${usageLimit}\n`,
      stderr: "",
      timedOut: false,
    });
    expect(result.exitReason).toBe("window_exhausted");
    expect(result.telemetry?.usageLimit?.message).toContain("usage limit");
  });

  it("does not leak auth secrets through commands or writer results", async () => {
    const result = await runWithClaudeResult({
      exitCode: 0,
      stdout: "{}\n",
      stderr: "",
      timedOut: false,
    });
    expect(JSON.stringify(result)).not.toContain("secret-access-token");
  });

  it("omits the --model flag when no model is pinned", () => {
    const command = buildClaudeWriterCommand({
      configDir: "/home/tanren/claude",
      workspace: "/workspace/repo",
    });
    expect(command).not.toContain("--model");
    expect(command).toContain("--add-dir '/workspace/repo'");
  });

  // SaaS Tier-B #5: managed mode points the Claude CLI at the platform endpoint
  // via ANTHROPIC_BASE_URL. BYOK (no override) leaves it untouched.
  it("sets ANTHROPIC_BASE_URL when a managed endpoint override is present", () => {
    const command = buildClaudeWriterCommand({
      configDir: "/home/tanren/claude",
      workspace: "/workspace/repo",
      endpointBaseUrl: "https://openrouter.ai/api/v1",
    });
    expect(command).toContain("ANTHROPIC_BASE_URL='https://openrouter.ai/api/v1'");
  });

  it("does not set ANTHROPIC_BASE_URL for a BYOK run", () => {
    const command = buildClaudeWriterCommand({
      configDir: "/home/tanren/claude",
      workspace: "/workspace/repo",
    });
    expect(command).not.toContain("ANTHROPIC_BASE_URL");
  });

  it("maps the Claude disjoint usage shape straight across with no de-overlap", () => {
    const line = JSON.stringify({
      type: "result",
      usage: {
        input_tokens: 100,
        output_tokens: 40,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      },
    });
    expect(parseClaudeStreamTelemetry(`${line}\n`).tokenUsage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 10,
      cacheCreationTokens: 5,
      outputTokens: 40,
      reasoningOutputTokens: 0,
      totalTokens: 155,
    });
  });
});

function ok(stdout: string): SshCommandResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

async function runWithClaudeResult(claudeResult: SshCommandResult) {
  const ssh = new ScriptedSsh([ok(""), ok(`${baselineSha}\n`), claudeResult, ok(""), ok(""), ok("")]);
  const secrets = new InMemorySecretStore();
  await secrets.put({ ref: "credential/claude/dev", value: authJson });
  const writer = createClaudeWriter({
    secrets,
    ssh,
    target,
    credentialRef: "credential/claude/dev",
    runId: "run_claude_2",
  });
  return await writer.runWriter({ prompt: "write", workspace: "/workspace/repo", timeoutMs: 1000 });
}

class ScriptedSsh implements SshSubstrate {
  readonly commands: Array<{ target: SshTarget; command: SshCommand }> = [];

  constructor(private readonly results: SshCommandResult[]) {}

  async run(sshTarget: SshTarget, command: SshCommand): Promise<SshCommandResult> {
    this.commands.push({ target: sshTarget, command });
    const result = this.results.shift();
    if (result === undefined) {
      throw new Error(`unexpected SSH command: ${command.command}`);
    }
    return result;
  }
}
