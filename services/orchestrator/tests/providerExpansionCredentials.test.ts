import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import {
  storeClaudeAuthBundle,
  validateClaudeAuthBundle,
  validateClaudeCredentialRef,
} from "../src/engine/credentials/claudeAuth.js";
import { claudeConfigDirForRun, materializeClaudeAuthBundle } from "../src/engine/credentials/claudeMaterializer.js";
import { validateOpencodeAuthBundle, validateOpencodeCredentialRef } from "../src/engine/credentials/opencodeAuth.js";
import {
  materializeOpencodeAuthBundle,
  opencodeDataHomeForRun,
} from "../src/engine/credentials/opencodeMaterializer.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU",
  identitySecretRef: "runner/local/identity",
};

const claudeJson = JSON.stringify({
  claudeAiOauth: { accessToken: "secret-token", refreshToken: "refresh" },
});
const opencodeJson = JSON.stringify({ zai: { key: "secret-zai-key" } });

describe("Claude credential contracts", () => {
  it("validates the OAuth bundle and returns only a redacted import result", async () => {
    const secrets = new FakeSecretStore();
    const result = await storeClaudeAuthBundle(secrets, {
      ref: "credential/claude/dev",
      authJson: claudeJson,
    });
    expect(result).toEqual({
      credentialKind: "claude_cli_auth",
      ref: "credential/claude/dev",
      redacted: true,
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("accepts a raw API key bundle and rejects non-Claude JSON and namespaces", () => {
    expect(validateClaudeAuthBundle(JSON.stringify({ ANTHROPIC_API_KEY: "sk-ant" })).authJson).toContain(
      "ANTHROPIC_API_KEY",
    );
    expect(() => validateClaudeAuthBundle("{}")).toThrow("must not be empty");
    expect(() => validateClaudeAuthBundle(JSON.stringify({ ok: true }))).toThrow("Claude CLI token fields");
    expect(() => validateClaudeCredentialRef("credential/codex/dev")).toThrow("credential/claude/");
  });

  it("accepts every recognized OAuth token field name and rejects empty ones", () => {
    for (const field of ["accessToken", "refreshToken", "access_token", "refresh_token"]) {
      expect(validateClaudeAuthBundle(JSON.stringify({ claudeAiOauth: { [field]: "tok" } })).authJson).toContain(
        "claudeAiOauth",
      );
    }
    // An OAuth container that carries only empty tokens is not a valid bundle.
    expect(() => validateClaudeAuthBundle(JSON.stringify({ claudeAiOauth: { accessToken: "" } }))).toThrow(
      "Claude CLI token fields",
    );
    // A non-object OAuth container does not satisfy the token check.
    expect(() => validateClaudeAuthBundle(JSON.stringify({ claudeAiOauth: "nope" }))).toThrow(
      "Claude CLI token fields",
    );
    // An empty API key is rejected.
    expect(() => validateClaudeAuthBundle(JSON.stringify({ ANTHROPIC_API_KEY: "" }))).toThrow(
      "Claude CLI token fields",
    );
  });

  it("rejects arrays, null, and non-JSON Claude bundles", () => {
    expect(() => validateClaudeAuthBundle("[]")).toThrow("must be a JSON object");
    expect(() => validateClaudeAuthBundle("null")).toThrow("must be a JSON object");
    expect(() => validateClaudeAuthBundle("nope")).toThrow("valid JSON");
  });

  it("materializes credentials into a per-run CLAUDE_CONFIG_DIR without returning secrets", async () => {
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/claude/dev", value: claudeJson });
    const ssh = new CapturingSsh();
    const result = await materializeClaudeAuthBundle({
      secrets,
      ssh,
      target,
      ref: "credential/claude/dev",
      runId: "run_123",
    });
    expect(result).toEqual({
      CLAUDE_CONFIG_DIR: "/home/tanren/.tanren/runs/run_123/claude-home",
      ref: "credential/claude/dev",
      managed: false,
      redacted: true,
    });
    expect(ssh.command).toContain(".credentials.json");
    expect(ssh.command).not.toContain("secret-token");
    expect(ssh.stdin).toBe(claudeJson);
  });

  it("MANAGED: materializes a settings.json OpenRouter env block (no claude-bundle validation)", async () => {
    const secrets = new FakeSecretStore();
    // A managed run's secret is a PLAIN OpenRouter key, NOT a claude bundle.
    await secrets.put({ ref: "credential/openrouter/platform/default", value: "sk-or-v1-claude" });
    const ssh = new CapturingSsh();
    const result = await materializeClaudeAuthBundle({
      secrets,
      ssh,
      target,
      ref: "credential/openrouter/platform/default",
      runId: "run_managed_c",
      managed: true,
      endpointBaseUrl: "https://openrouter.ai/api/v1",
    });
    expect(result).toEqual({
      CLAUDE_CONFIG_DIR: "/home/tanren/.tanren/runs/run_managed_c/claude-home",
      ref: "credential/openrouter/platform/default",
      // The cookbook needs the `/api` base, NOT `/api/v1`.
      anthropicBaseUrl: "https://openrouter.ai/api",
      managed: true,
      redacted: true,
    });
    // settings.json (not .credentials.json) carries the env block; the secret
    // AUTH_TOKEN arrives on stdin, never in the command string.
    expect(ssh.command).toContain("settings.json");
    expect(ssh.command).not.toContain("sk-or-v1-claude");
    expect(JSON.parse(ssh.stdin ?? "{}")).toEqual({
      env: {
        ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
        ANTHROPIC_AUTH_TOKEN: "sk-or-v1-claude",
        ANTHROPIC_API_KEY: "",
      },
    });
    expect(JSON.stringify(result)).not.toContain("sk-or-v1-claude");
  });

  it("MANAGED claude rejects a missing endpoint or empty key loudly", async () => {
    const secrets = new FakeSecretStore();
    const ssh = new CapturingSsh();
    await secrets.put({ ref: "credential/openrouter/platform/default", value: "sk-or-v1-x" });
    await expect(
      materializeClaudeAuthBundle({
        secrets,
        ssh,
        target,
        ref: "credential/openrouter/platform/default",
        runId: "run_managed_c2",
        managed: true,
      }),
    ).rejects.toThrow("managed Claude run requires an endpoint base URL");
    await secrets.put({ ref: "credential/openrouter/platform/blank", value: "  " });
    await expect(
      materializeClaudeAuthBundle({
        secrets,
        ssh,
        target,
        ref: "credential/openrouter/platform/blank",
        runId: "run_managed_c3",
        managed: true,
        endpointBaseUrl: "https://openrouter.ai/api/v1",
      }),
    ).rejects.toThrow("resolved to an empty api key");
  });

  it("throws when the materialized credential ref is missing from the store", async () => {
    const secrets = new FakeSecretStore();
    const ssh = new CapturingSsh();
    await expect(
      materializeClaudeAuthBundle({ secrets, ssh, target, ref: "credential/claude/dev", runId: "run_1" }),
    ).rejects.toThrow("missing Claude credential ref: credential/claude/dev");
    // No command should have been sent when the secret is absent.
    expect(ssh.command).toBe("");
  });

  it("derives CLAUDE_CONFIG_DIR from the run id and rejects an unsafe run id", () => {
    expect(claudeConfigDirForRun("run_9", "/base/")).toBe("/base/run_9/claude-home");
    expect(() => claudeConfigDirForRun("../escape")).toThrow("run id is not safe");
  });
});

describe("opencode credential contracts", () => {
  it("requires a Zai GLM provider entry and rejects non-opencode namespaces", () => {
    expect(validateOpencodeAuthBundle(opencodeJson).authJson).toContain("zai");
    expect(() => validateOpencodeAuthBundle(JSON.stringify({ wafer: { key: "x" } }))).toThrow("Zai GLM provider entry");
    expect(() => validateOpencodeAuthBundle("{}")).toThrow("must not be empty");
    expect(() => validateOpencodeCredentialRef("credential/claude/dev")).toThrow("credential/opencode/");
  });

  it("accepts every recognized Zai key field and rejects empty / non-object entries", () => {
    for (const field of ["key", "apiKey", "api_key", "access", "accessToken"]) {
      expect(validateOpencodeAuthBundle(JSON.stringify({ zai: { [field]: "tok" } })).authJson).toContain("zai");
    }
    // An empty key value does not count.
    expect(() => validateOpencodeAuthBundle(JSON.stringify({ zai: { key: "" } }))).toThrow("Zai GLM provider entry");
    // A non-object zai entry does not count.
    expect(() => validateOpencodeAuthBundle(JSON.stringify({ zai: "tok" }))).toThrow("Zai GLM provider entry");
    expect(() => validateOpencodeAuthBundle(JSON.stringify({ zai: ["tok"] }))).toThrow("Zai GLM provider entry");
  });

  it("rejects arrays, null, and non-JSON opencode bundles", () => {
    expect(() => validateOpencodeAuthBundle("[]")).toThrow("must be a JSON object");
    expect(() => validateOpencodeAuthBundle("null")).toThrow("must be a JSON object");
    expect(() => validateOpencodeAuthBundle("nope")).toThrow("valid JSON");
  });

  it("materializes auth.json into a per-run XDG_DATA_HOME without returning secrets", async () => {
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/opencode/dev", value: opencodeJson });
    const ssh = new CapturingSsh();
    const result = await materializeOpencodeAuthBundle({
      secrets,
      ssh,
      target,
      ref: "credential/opencode/dev",
      runId: "run_123",
    });
    expect(result).toEqual({
      XDG_DATA_HOME: "/home/tanren/.tanren/runs/run_123/opencode-home",
      ref: "credential/opencode/dev",
      managed: false,
      redacted: true,
    });
    expect(ssh.command).toContain("opencode/auth.json");
    expect(ssh.command).not.toContain("secret-zai-key");
    expect(ssh.stdin).toBe(opencodeJson);
  });

  it("MANAGED: materializes an openrouter auth.json + opencode.json (no Zai-bundle validation)", async () => {
    const secrets = new FakeSecretStore();
    // A managed run's secret is a PLAIN OpenRouter key, NOT a Zai opencode bundle.
    await secrets.put({ ref: "credential/openrouter/platform/default", value: "sk-or-v1-oc" });
    const ssh = new CapturingSsh();
    const result = await materializeOpencodeAuthBundle({
      secrets,
      ssh,
      target,
      ref: "credential/openrouter/platform/default",
      runId: "run_managed_o",
      managed: true,
    });
    expect(result).toEqual({
      XDG_DATA_HOME: "/home/tanren/.tanren/runs/run_managed_o/opencode-home",
      ref: "credential/openrouter/platform/default",
      XDG_CONFIG_HOME: "/home/tanren/.tanren/runs/run_managed_o/opencode-config",
      managed: true,
      redacted: true,
    });
    // Two commands: auth.json (secret on stdin) then opencode.json (no secret).
    expect(ssh.commands).toHaveLength(2);
    expect(ssh.commands[0]?.command).toContain("opencode/auth.json");
    expect(ssh.commands[0]?.command).not.toContain("sk-or-v1-oc");
    expect(JSON.parse(ssh.commands[0]?.stdin ?? "{}")).toEqual({
      openrouter: { type: "api", key: "sk-or-v1-oc" },
    });
    expect(ssh.commands[1]?.command).toContain("opencode.json");
    expect(ssh.commands[1]?.command).toContain("openrouter");
    expect(JSON.stringify(result)).not.toContain("sk-or-v1-oc");
  });

  it("MANAGED opencode rejects an empty key loudly", async () => {
    const secrets = new FakeSecretStore();
    const ssh = new CapturingSsh();
    await secrets.put({ ref: "credential/openrouter/platform/blank", value: "   " });
    await expect(
      materializeOpencodeAuthBundle({
        secrets,
        ssh,
        target,
        ref: "credential/openrouter/platform/blank",
        runId: "run_managed_o2",
        managed: true,
      }),
    ).rejects.toThrow("resolved to an empty api key");
  });

  it("throws when the opencode credential ref is missing and derives a per-run data home", async () => {
    const secrets = new FakeSecretStore();
    const ssh = new CapturingSsh();
    await expect(
      materializeOpencodeAuthBundle({ secrets, ssh, target, ref: "credential/opencode/dev", runId: "run_1" }),
    ).rejects.toThrow("missing opencode credential ref: credential/opencode/dev");
    expect(opencodeDataHomeForRun("run_2", "/base/")).toBe("/base/run_2/opencode-home");
    expect(() => opencodeDataHomeForRun("bad/id")).toThrow("run id is not safe");
  });
});

class CapturingSsh implements CommandSubstrate {
  command = "";
  stdin: string | undefined;
  result: CommandResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  readonly commands: Array<{ command: string; stdin: string | undefined }> = [];

  async run(_target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.command = command.command;
    this.stdin = command.stdin;
    this.commands.push({ command: command.command, stdin: command.stdin });
    return this.result;
  }
}

describe("materialization failure surfacing", () => {
  it("surfaces a non-zero exit code as a Claude materialization failure", async () => {
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/claude/dev", value: claudeJson });
    const ssh = new CapturingSsh();
    ssh.result = { exitCode: 7, stdout: "", stderr: "denied", timedOut: false };
    await expect(
      materializeClaudeAuthBundle({ secrets, ssh, target, ref: "credential/claude/dev", runId: "run_1" }),
    ).rejects.toThrow("Claude credential materialization failed: file write failed with exit code 7");
  });

  it("surfaces an SSH failure message for opencode materialization", async () => {
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/opencode/dev", value: opencodeJson });
    const ssh = new CapturingSsh();
    ssh.result = {
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: true,
      failure: { kind: "ssh_failed", target: "runner", message: "ssh dial timed out" },
    };
    await expect(
      materializeOpencodeAuthBundle({ secrets, ssh, target, ref: "credential/opencode/dev", runId: "run_1" }),
    ).rejects.toThrow("opencode credential materialization failed: ssh dial timed out");
  });
});
