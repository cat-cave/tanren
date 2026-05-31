import { describe, expect, it } from "vitest";
import type { SshTarget } from "../src/engine/contracts/allocator.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import {
  buildReasonixWriterCommand,
  createReasonixWriter,
  parseReasonixStreamTelemetry,
} from "../src/engine/providers/reasonix.js";

const target: SshTarget = {
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

const apiKey = "sk-deepseek-secret-key";
const baselineSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("reasonix writer adapter", () => {
  it("runs reasonix non-interactively in the workspace, parses git state into a WriterResult", async () => {
    const ssh = new ScriptedSsh([
      // baseline sha
      ok(`${baselineSha}\n`),
      ok(
        '{"type":"start"}\n' +
          '{"type":"done","usage":{"prompt_tokens":1500,"prompt_cache_hit_tokens":300,"completion_tokens":340,"reasoning_tokens":60}}\n',
        // reasonix run (NDJSON)
      ),
      // commit
      ok(""),
      // diff
      ok("diff --git a/Y.md b/Y.md\n+done\n"),
      // log
      ok(`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\treasonix writer\n`),
    ]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/reasonix/dev", value: apiKey });

    const writer = createReasonixWriter({
      secrets,
      ssh,
      target,
      credentialRef: "credential/reasonix/dev",
      runId: "run_reasonix_1",
    });
    const result = await writer.runWriter({
      prompt: "make a tiny edit",
      workspace: "/workspace/repo",
      timeoutMs: 1000,
    });

    const reasonixCommand = ssh.commands[1]?.command;
    expect(reasonixCommand?.command).toContain("reasonix run");
    expect(reasonixCommand?.command).toContain("'make a tiny edit'");
    expect(reasonixCommand?.command).toContain("DEEPSEEK_API_KEY=");
    expect(reasonixCommand?.cwd).toBe("/workspace/repo");
    expect(writer.cli).toBe("reasonix");
    expect(writer.authRef).toBe("credential/reasonix/dev");
    expect(result).toMatchObject({
      diff: "diff --git a/Y.md b/Y.md\n+done\n",
      exitReason: "completed",
      commits: [{ sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", message: "reasonix writer" }],
      // prompt_tokens (1500) is inclusive of cache hits (300), de-overlapped:
      // inputTokens = 1500 - 300 = 1200; cachedInputTokens = 300.
      tokenUsage: {
        inputTokens: 1200,
        cachedInputTokens: 300,
        cacheCreationTokens: 0,
        outputTokens: 340,
        reasoningOutputTokens: 60,
        totalTokens: 1900,
      },
    });
  });

  it("resolves the DeepSeek API key from the credential store via authRef", async () => {
    const ssh = new ScriptedSsh([ok(`${baselineSha}\n`), ok(""), ok(""), ok(""), ok("")]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/reasonix/dev", value: apiKey });
    const writer = createReasonixWriter({
      secrets,
      ssh,
      target,
      credentialRef: "credential/reasonix/dev",
      runId: "run_reasonix_2",
    });
    await writer.runWriter({ prompt: "edit", workspace: "/workspace/repo", timeoutMs: 1000 });
    expect(ssh.commands[1]?.command.command).toContain(`DEEPSEEK_API_KEY='${apiKey}'`);
  });

  it("throws when the credential ref is missing", async () => {
    const ssh = new ScriptedSsh([ok(`${baselineSha}\n`)]);
    const writer = createReasonixWriter({
      secrets: new InMemorySecretStore(),
      ssh,
      target,
      credentialRef: "credential/reasonix/absent",
      runId: "run_reasonix_3",
    });
    await expect(writer.runWriter({ prompt: "edit", workspace: "/workspace/repo", timeoutMs: 1000 })).rejects.toThrow(
      /missing reasonix credential ref/u,
    );
  });

  it("returns timeout, crashed, and window_exhausted distinctly", async () => {
    const timeout = await runWith({ exitCode: null, stdout: "", stderr: "", timedOut: true });
    const crashed = await runWith({ exitCode: 2, stdout: "", stderr: "boom", timedOut: false });
    const limit = await runWith({
      exitCode: 0,
      stdout: '{"type":"error","error":{"message":"You have hit your usage limit, try again later."}}',
      stderr: "",
      timedOut: false,
    });
    expect(timeout.exitReason).toBe("timeout");
    expect(crashed.exitReason).toBe("crashed");
    expect(limit.exitReason).toBe("window_exhausted");
  });

  it("does not leak the API key through commands or results", async () => {
    const result = await runWith({ exitCode: 0, stdout: '{"type":"done"}', stderr: "", timedOut: false });
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it("builds the headless `run` command with the DeepSeek env var and optional model", () => {
    expect(buildReasonixWriterCommand({ apiKey: "k", task: "do it" })).toContain("reasonix run 'do it'");
    expect(buildReasonixWriterCommand({ apiKey: "k", task: "do it" })).toContain("DEEPSEEK_API_KEY=");
    expect(buildReasonixWriterCommand({ apiKey: "k", task: "do it", model: "deepseek-reasoner" })).toContain(
      "--model 'deepseek-reasoner'",
    );
    expect(buildReasonixWriterCommand({ apiKey: "k", task: "do it" })).not.toContain("--model");
  });

  it("parses NDJSON token usage into disjoint buckets (de-overlapping cache hits)", () => {
    const telemetry = parseReasonixStreamTelemetry(
      '{"usage":{"prompt_tokens":2500,"prompt_cache_hit_tokens":500,"completion_tokens":800}}\n',
    );
    expect(telemetry.tokenUsage).toEqual({
      inputTokens: 2000,
      cachedInputTokens: 500,
      cacheCreationTokens: 0,
      outputTokens: 800,
      reasoningOutputTokens: 0,
      totalTokens: 3300,
    });
  });

  it("omits token usage when reasonix reports no usage event", () => {
    expect(parseReasonixStreamTelemetry('{"type":"log","message":"hi"}\n').tokenUsage).toBeUndefined();
  });
});

function ok(stdout: string): SshCommandResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

async function runWith(reasonixResult: SshCommandResult) {
  const ssh = new ScriptedSsh([ok(`${baselineSha}\n`), reasonixResult, ok(""), ok(""), ok("")]);
  const secrets = new InMemorySecretStore();
  await secrets.put({ ref: "credential/reasonix/dev", value: apiKey });
  const writer = createReasonixWriter({
    secrets,
    ssh,
    target,
    credentialRef: "credential/reasonix/dev",
    runId: "run_reasonix_x",
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
