import { describe, expect, it } from "vitest";
import type { SshTarget } from "../src/engine/contracts/allocator.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import { buildCodexExecCommand, createCodexWriter, parseCodexJsonlTelemetry } from "../src/engine/providers/codex.js";

const target: SshTarget = {
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

const authJson = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    access_token: "secret-access-token",
    refresh_token: "secret-refresh-token",
  },
});

describe("Codex writer adapter", () => {
  it("constructs codex exec with per-run CODEX_HOME, workspace-write, JSONL, and stdin prompt", async () => {
    const ssh = new ScriptedSsh([
      ok(""),
      ok("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n"),
      ok('{"type":"usage","usage":{"input_tokens":12,"output_tokens":5,"cached_input_tokens":3}}\n'),
      ok(refreshedAuthJson()),
      ok(""),
      ok("diff --git a/LIVE.md b/LIVE.md\n+done\n"),
      ok(""),
    ]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/codex/dev", value: authJson });

    const writer = createCodexWriter({
      secrets,
      ssh,
      target,
      credentialRef: "credential/codex/dev",
      runId: "run_codex_1",
    });
    const result = await writer.runWriter({
      prompt: "make a tiny edit",
      workspace: "/workspace/repo",
      timeoutMs: 1000,
    });

    expect(ssh.commands[0]?.command.command).toContain("/run_codex_1/codex-home");
    expect(ssh.commands[0]?.command.stdin).toBe(authJson);
    expect(ssh.commands[2]?.command.command).toBe(
      "CODEX_HOME='/home/tanren/.tanren/runs/run_codex_1/codex-home' codex exec --sandbox workspace-write --json --ignore-user-config --cd '/workspace/repo' -",
    );
    expect(ssh.commands[2]?.command.stdin).toBe("make a tiny edit");
    expect(ssh.commands[4]?.command.command).toContain("git commit -m 'codex writer'");
    expect(result).toMatchObject({
      diff: "diff --git a/LIVE.md b/LIVE.md\n+done\n",
      commits: [],
      exitReason: "completed",
      tokenUsage: {
        inputTokens: 9,
        cachedInputTokens: 3,
        cacheCreationTokens: 0,
        outputTokens: 5,
        reasoningOutputTokens: 0,
        totalTokens: 17,
      },
      telemetry: {
        rawEventCount: 1,
        tokenUsage: {
          inputTokens: 9,
          cachedInputTokens: 3,
          cacheCreationTokens: 0,
          outputTokens: 5,
          reasoningOutputTokens: 0,
          totalTokens: 17,
        },
      },
    });
  });

  it("returns timeout and crashed results without treating stdout as completion", async () => {
    const timeout = await runWithCodexResult(
      { exitCode: null, stdout: '{"type":"done"}\n', stderr: "", timedOut: true },
      {
        diff: "diff --git a/PARTIAL.md b/PARTIAL.md\n+partial\n",
        log: `${commitSha("d")}\tcodex writer\n`,
      },
    );
    const nonzero = await runWithCodexResult({
      exitCode: 2,
      stdout: '{"type":"done"}\n',
      stderr: "bad",
      timedOut: false,
    });

    expect(timeout).toMatchObject({
      diff: "diff --git a/PARTIAL.md b/PARTIAL.md\n+partial\n",
      commits: [{ sha: commitSha("d"), message: "codex writer" }],
      exitReason: "timeout",
      telemetry: { rawEventCount: 1 },
    });
    expect(nonzero).toMatchObject({
      diff: "",
      commits: [],
      exitReason: "crashed",
      telemetry: { rawEventCount: 1 },
    });
  });

  it("judges successful completion from git state after Codex exits", async () => {
    const completedCommitSha = "cccccccccccccccccccccccccccccccccccccccc";
    const result = await runWithCodexResult(ok("{}\n"), {
      diff: "diff --git a/CODEX.md b/CODEX.md\n+codex\n",
      log: `${completedCommitSha}\tcodex change\n`,
    });

    expect(result.diff).toContain("+codex");
    expect(result.commits).toEqual([{ sha: completedCommitSha, message: "codex change" }]);
    expect(result.exitReason).toBe("completed");
  });

  // SaaS Tier-B #5: managed mode points codex at the platform endpoint via
  // OPENAI_BASE_URL; BYOK (no override) leaves it untouched.
  it("sets OPENAI_BASE_URL when a managed endpoint override is present", () => {
    const command = buildCodexExecCommand({
      codexHome: "/home/tanren/.codex",
      workspace: "/workspace/repo",
      endpointBaseUrl: "https://openrouter.ai/api/v1",
    });
    expect(command).toContain("OPENAI_BASE_URL='https://openrouter.ai/api/v1'");
  });

  it("does not set OPENAI_BASE_URL for a BYOK run", () => {
    const command = buildCodexExecCommand({ codexHome: "/home/tanren/.codex", workspace: "/workspace/repo" });
    expect(command).not.toContain("OPENAI_BASE_URL");
  });

  it("does not leak auth secrets through commands or writer results", async () => {
    const ssh = new ScriptedSsh([
      ok(""),
      ok("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n"),
      ok("{}\n"),
      ok(authJson),
      ok(""),
      ok("diff\n"),
      ok(""),
    ]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/codex/dev", value: authJson });

    const writer = createCodexWriter({
      secrets,
      ssh,
      target,
      credentialRef: "credential/codex/dev",
      runId: "run_secret",
    });
    const result = await writer.runWriter({
      prompt: "do work",
      workspace: "/workspace/repo",
      timeoutMs: 1000,
    });
    const commandText = ssh.commands.map((item) => item.command.command).join("\n");

    expect(commandText).not.toContain("secret-access-token");
    expect(commandText).not.toContain("secret-refresh-token");
    expect(JSON.stringify(result)).not.toContain("secret-access-token");
    expect(JSON.stringify(result)).not.toContain("secret-refresh-token");
  });

  it("treats refreshed auth write-back as best effort", async () => {
    const ssh = new ScriptedSsh([
      ok(""),
      ok("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n"),
      ok("{}\n"),
      ok("not-json"),
      ok(""),
      ok("diff --git a/CODEX.md b/CODEX.md\n+codex\n"),
      ok(`${commitSha("e")}\tcodex writer\n`),
    ]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/codex/dev", value: authJson });

    const writer = createCodexWriter({
      secrets,
      ssh,
      target,
      credentialRef: "credential/codex/dev",
      runId: "run_refresh",
    });
    const result = await writer.runWriter({
      prompt: "do work",
      workspace: "/workspace/repo",
      timeoutMs: 1000,
    });

    expect(result.exitReason).toBe("completed");
    await expect(secrets.get("credential/codex/dev")).resolves.toMatchObject({ value: authJson });
  });

  it("parses raw Codex JSONL count and optional token usage", () => {
    expect(parseCodexJsonlTelemetry('{}\nnot-json\n{"usage":{"promptTokens":7,"completionTokens":4}}\n')).toEqual({
      rawEventCount: 3,
      tokenUsage: {
        inputTokens: 7,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 4,
        reasoningOutputTokens: 0,
        totalTokens: 11,
      },
    });
  });

  it("de-overlaps Codex inclusive token shape into disjoint buckets", () => {
    // Real Codex shape: cached_input_tokens ⊆ input_tokens and
    // reasoning_output_tokens ⊆ output_tokens, so input/output must shed the
    // overlap to keep the buckets mutually exclusive.
    const line = JSON.stringify({
      type: "usage",
      usage: {
        input_tokens: 11460,
        cached_input_tokens: 4480,
        output_tokens: 461,
        reasoning_output_tokens: 316,
        total_tokens: 11921,
      },
    });
    expect(parseCodexJsonlTelemetry(`${line}\n`).tokenUsage).toEqual({
      inputTokens: 6980,
      cachedInputTokens: 4480,
      cacheCreationTokens: 0,
      outputTokens: 145,
      reasoningOutputTokens: 316,
      totalTokens: 11921,
    });
  });

  it("detects a usage-limit signal from the turn.failed error envelope", () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"turn.started"}',
      '{"type":"error","message":"You\'ve hit your usage limit. Visit ... or try again at May 30th, 2026 8:19 PM."}',
      '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit. ... try again at May 30th, 2026 8:19 PM."}}',
    ].join("\n");
    const telemetry = parseCodexJsonlTelemetry(stdout);
    expect(telemetry.usageLimit?.message).toContain("usage limit");
    expect(telemetry.usageLimit?.message).toContain("May 30th");
  });

  it("returns window_exhausted (not crashed) when the account hits its usage limit", async () => {
    const usageLimitStdout = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"turn.started"}',
      '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit. try again at May 30th, 2026 8:19 PM."}}',
    ].join("\n");
    // exitCode 0 here proves the distinction is driven by the parsed signal,
    // not the process exit code: codex can exit 0 yet still report the limit.
    const result = await runWithCodexResult({
      exitCode: 0,
      stdout: usageLimitStdout,
      stderr: "",
      timedOut: false,
    });
    expect(result.exitReason).toBe("window_exhausted");
    expect(result.telemetry?.usageLimit?.message).toContain("usage limit");
  });
});

function commitSha(char: string): string {
  return char.repeat(40);
}

function ok(stdout: string): SshCommandResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

function refreshedAuthJson(): string {
  return JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "new-token" } });
}

const EMPTY_GIT_STATE: { diff: string; log: string } = { diff: "", log: "" };

async function runWithCodexResult(
  codexResult: SshCommandResult,
  gitState: { diff: string; log: string } = EMPTY_GIT_STATE,
) {
  const ssh = new ScriptedSsh([
    ok(""),
    ok("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n"),
    codexResult,
    ok(refreshedAuthJson()),
    ok(""),
    ok(gitState.diff),
    ok(gitState.log),
  ]);
  const secrets = new InMemorySecretStore();
  await secrets.put({ ref: "credential/codex/dev", value: authJson });
  const writer = createCodexWriter({
    secrets,
    ssh,
    target,
    credentialRef: "credential/codex/dev",
    runId: "run_codex_2",
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
