import { describe, expect, it } from "vitest";
import type { SshTarget } from "../src/engine/contracts/allocator.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import {
  buildOpencodeWriterCommand,
  createOpencodeWriter,
  parseOpencodeStreamTelemetry,
  ZAI_GLM_MODEL,
} from "../src/engine/providers/opencode.js";

const target: SshTarget = {
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

const authJson = JSON.stringify({ zai: { key: "secret-zai-key" } });

const baselineSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("opencode writer adapter", () => {
  it("constructs opencode run with per-run XDG_DATA_HOME, the Zai GLM model, workspace, and stdin prompt", async () => {
    const usageLine = JSON.stringify({
      type: "completion",
      usage: { input_tokens: 20, output_tokens: 8, cache_read: 4 },
    });
    const ssh = new ScriptedSsh([
      ok(""), // materialize auth
      ok(`${baselineSha}\n`), // baseline sha
      ok(`${usageLine}\n`), // opencode run
      ok(""), // commit
      ok("diff --git a/Y.md b/Y.md\n+done\n"), // diff
      ok(""), // log
    ]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/opencode/dev", value: authJson });

    const writer = createOpencodeWriter({
      secrets,
      ssh,
      target,
      credentialRef: "credential/opencode/dev",
      runId: "run_oc_1",
    });
    const result = await writer.runWriter({
      prompt: "make a tiny edit",
      workspace: "/workspace/repo",
      timeoutMs: 1000,
    });

    expect(ssh.commands[0]?.command.command).toContain("/run_oc_1/opencode-home");
    expect(ssh.commands[0]?.command.stdin).toBe(authJson);
    expect(ssh.commands[2]?.command.command).toContain("opencode run");
    expect(ssh.commands[2]?.command.command).toContain(`--model '${ZAI_GLM_MODEL}'`);
    expect(ssh.commands[2]?.command.command).toContain("--cwd '/workspace/repo'");
    expect(ssh.commands[2]?.command.stdin).toBe("make a tiny edit");
    expect(ssh.commands[3]?.command.command).toContain("git commit -m 'opencode writer'");
    expect(writer.cli).toBe("opencode");
    expect(result).toMatchObject({
      diff: "diff --git a/Y.md b/Y.md\n+done\n",
      exitReason: "completed",
      tokenUsage: {
        inputTokens: 20,
        cachedInputTokens: 4,
        cacheCreationTokens: 0,
        outputTokens: 8,
        reasoningOutputTokens: 0,
        totalTokens: 32,
      },
    });
  });

  it("defaults to the Zai GLM 5.1 model when none is pinned", () => {
    expect(ZAI_GLM_MODEL).toBe("zai/glm-5.1");
    const command = buildOpencodeWriterCommand({
      dataHome: "/data",
      workspace: "/workspace/repo",
      model: ZAI_GLM_MODEL,
    });
    expect(command).toContain("--model 'zai/glm-5.1'");
  });

  it("returns timeout, crashed, and window_exhausted distinctly", async () => {
    const timeout = await runWith({ exitCode: null, stdout: "{}\n", stderr: "", timedOut: true });
    const crashed = await runWith({ exitCode: 3, stdout: "{}\n", stderr: "boom", timedOut: false });
    const limit = await runWith({
      exitCode: 0,
      stdout: '{"type":"error","error":{"message":"You have hit your rate limit."}}\n',
      stderr: "",
      timedOut: false,
    });
    expect(timeout.exitReason).toBe("timeout");
    expect(crashed.exitReason).toBe("crashed");
    expect(limit.exitReason).toBe("window_exhausted");
  });

  it("does not leak the Zai key through commands or results", async () => {
    const result = await runWith({ exitCode: 0, stdout: "{}\n", stderr: "", timedOut: false });
    expect(JSON.stringify(result)).not.toContain("secret-zai-key");
  });

  it("maps opencode disjoint usage straight across with no de-overlap", () => {
    const line = JSON.stringify({
      usage: { input_tokens: 50, output_tokens: 30, cache_read: 5, cache_write: 2 },
    });
    expect(parseOpencodeStreamTelemetry(`${line}\n`).tokenUsage).toEqual({
      inputTokens: 50,
      cachedInputTokens: 5,
      cacheCreationTokens: 2,
      outputTokens: 30,
      reasoningOutputTokens: 0,
      totalTokens: 87,
    });
  });
});

function ok(stdout: string): SshCommandResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

async function runWith(opencodeResult: SshCommandResult) {
  const ssh = new ScriptedSsh([ok(""), ok(`${baselineSha}\n`), opencodeResult, ok(""), ok(""), ok("")]);
  const secrets = new InMemorySecretStore();
  await secrets.put({ ref: "credential/opencode/dev", value: authJson });
  const writer = createOpencodeWriter({
    secrets,
    ssh,
    target,
    credentialRef: "credential/opencode/dev",
    runId: "run_oc_2",
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
