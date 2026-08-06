import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { buildPiWriterCommand, createPiWriter, parsePiTelemetry } from "../src/engine/providers/pi.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

const apiKey = "sk-pi-secret-key";
const baselineSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("pi writer adapter", () => {
  it("runs pi non-interactively in the workspace, parses git state into a WriterResult", async () => {
    const ssh = new ScriptedSsh([
      // baseline sha
      ok(`${baselineSha}\n`),
      // pi run
      ok("Edited Y.md\nTokens: 1,200 sent, 340 received\n"),
      // stage
      ok(""),
      // commit
      ok(""),
      // diff
      ok("diff --git a/Y.md b/Y.md\n+done\n"),
      // log
      ok(`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tpi writer\n`),
    ]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/pi/dev", value: apiKey });

    const writer = createPiWriter({
      secrets,
      ssh,
      target,
      credentialRef: "credential/pi/dev",
      runId: "run_pi_1",
    });
    const result = await writer.runWriter({
      prompt: "make a tiny edit",
      workspace: "/workspace/repo",
    });

    const piCommand = ssh.commands[1]?.command;
    expect(piCommand?.command).toContain("pi");
    expect(piCommand?.command).toContain("-p 'make a tiny edit'");
    // SECURITY: the key VALUE never appears in the command string; the command
    // sources a chmod-600 env file whose `export …` line arrives on stdin.
    expect(piCommand?.command).toContain("chmod 600");
    expect(piCommand?.command).not.toContain(apiKey);
    expect(piCommand?.stdin).toContain(`export ANTHROPIC_API_KEY='${apiKey}'`);
    expect(piCommand?.cwd).toBe("/workspace/repo");
    expect(writer.cli).toBe("pi");
    expect(writer.authRef).toBe("credential/pi/dev");
    expect(result).toMatchObject({
      diff: "diff --git a/Y.md b/Y.md\n+done\n",
      exitReason: "completed",
      commits: [{ sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", message: "pi writer" }],
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

  it("resolves the underlying-LLM API key from the credential store and passes it via stdin (never argv)", async () => {
    const ssh = new ScriptedSsh([ok(`${baselineSha}\n`), ok(""), ok(""), ok(""), ok(""), ok("")]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/pi/dev", value: apiKey });
    const writer = createPiWriter({
      secrets,
      ssh,
      target,
      credentialRef: "credential/pi/dev",
      runId: "run_pi_2",
    });
    await writer.runWriter({ prompt: "edit", workspace: "/workspace/repo" });
    // The key rides stdin into a chmod-600 env file, NOT the command string.
    expect(ssh.commands[1]?.command.stdin).toContain(`export ANTHROPIC_API_KEY='${apiKey}'`);
    expect(ssh.commands[1]?.command.command).not.toContain(apiKey);
  });

  it("throws when the credential ref is missing", async () => {
    const ssh = new ScriptedSsh([ok(`${baselineSha}\n`)]);
    const writer = createPiWriter({
      secrets: new InMemorySecretStore(),
      ssh,
      target,
      credentialRef: "credential/pi/absent",
      runId: "run_pi_3",
    });
    await expect(writer.runWriter({ prompt: "edit", workspace: "/workspace/repo" })).rejects.toThrow(
      /missing pi credential ref/u,
    );
  });

  it("returns timeout, crashed, and window_exhausted distinctly", async () => {
    const timeout = await runWith({ exitCode: null, stdout: "", stderr: "", stalled: true });
    const crashed = await runWith({ exitCode: 2, stdout: "", stderr: "boom" });
    const limit = await runWith({
      exitCode: 0,
      stdout: "Error: You have hit your rate limit, try again later.",
      stderr: "",
    });
    expect(timeout.exitReason).toBe("timeout");
    expect(crashed.exitReason).toBe("crashed");
    expect(limit.exitReason).toBe("window_exhausted");
  });

  it("does not leak the API key through commands or results", async () => {
    const result = await runWith({ exitCode: 0, stdout: "ok", stderr: "" });
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it("builds a non-interactive -p command that sources a chmod-600 key file rather than argv-injecting the key", () => {
    const command = buildPiWriterCommand({ apiKeyEnvVar: "ANTHROPIC_API_KEY", prompt: "do it", runId: "run_build_1" });
    expect(command).toContain("pi -p 'do it'");
    expect(command).toContain("chmod 600");
    expect(command).toContain(". '/tmp/tanren-pi-run_build_1.env'");
    // The key env-var ASSIGNMENT never appears in argv (only the file source).
    expect(command).not.toContain("ANTHROPIC_API_KEY=");
  });

  // SaaS Tier-B #5: managed mode points pi at the OpenRouter endpoint with the
  // platform key via OPENAI_API_KEY + OPENAI_BASE_URL. Asserts the COMMAND
  // outcome, not mocks.
  it("points pi at the managed endpoint with the OpenAI key when an override is set", async () => {
    const ssh = new ScriptedSsh([ok(`${baselineSha}\n`), ok(""), ok(""), ok(""), ok(""), ok("")]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/openrouter/platform/default", value: "or-platform-key" });
    const writer = createPiWriter({
      secrets,
      ssh,
      target,
      credentialRef: "credential/openrouter/platform/default",
      runId: "run_pi_managed",
      endpointBaseUrl: "https://openrouter.ai/api/v1",
    });
    await writer.runWriter({ prompt: "edit", workspace: "/workspace/repo" });
    const piCmd = ssh.commands[1]?.command;
    const piCommand = piCmd?.command ?? "";
    // OPENAI_BASE_URL is NON-secret → fine as a command-scoped env prefix (argv).
    expect(piCommand).toContain("OPENAI_BASE_URL='https://openrouter.ai/api/v1'");
    // The managed key rides stdin as OPENAI_API_KEY, never argv.
    expect(piCmd?.stdin).toContain("export OPENAI_API_KEY='or-platform-key'");
    expect(piCommand).not.toContain("or-platform-key");
    expect(piCommand).not.toContain("ANTHROPIC_API_KEY");
  });

  it("omits OPENAI_BASE_URL for a BYOK run (no override)", () => {
    const command = buildPiWriterCommand({ apiKeyEnvVar: "ANTHROPIC_API_KEY", prompt: "do it", runId: "run_byok_1" });
    expect(command).not.toContain("OPENAI_BASE_URL");
  });

  it("scrapes a human-readable token summary into disjoint buckets", () => {
    const telemetry = parsePiTelemetry("Edited\nTokens: 2,500 sent, 800 received\n");
    expect(telemetry.tokenUsage).toEqual({
      inputTokens: 2500,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 800,
      reasoningOutputTokens: 0,
      totalTokens: 3300,
    });
  });

  it("omits token usage when pi reports no summary line", () => {
    expect(parsePiTelemetry("Edited Y.md\n").tokenUsage).toBeUndefined();
  });
});

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

async function runWith(piResult: CommandResult) {
  const ssh = new ScriptedSsh([ok(`${baselineSha}\n`), piResult, ok(""), ok(""), ok(""), ok("")]);
  const secrets = new InMemorySecretStore();
  await secrets.put({ ref: "credential/pi/dev", value: apiKey });
  const writer = createPiWriter({
    secrets,
    ssh,
    target,
    credentialRef: "credential/pi/dev",
    runId: "run_pi_x",
  });
  return await writer.runWriter({ prompt: "write", workspace: "/workspace/repo" });
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
