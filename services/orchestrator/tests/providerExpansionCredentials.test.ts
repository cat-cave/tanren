import { describe, expect, it } from "vitest";
import type { SshTarget } from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import {
  storeClaudeAuthBundle,
  validateClaudeAuthBundle,
  validateClaudeCredentialRef,
} from "../src/engine/credentials/claudeAuth.js";
import {
  buildClaudeAuthMaterializationCommand,
  claudeConfigDirForRun,
  materializeClaudeAuthBundle,
} from "../src/engine/credentials/claudeMaterializer.js";
import { validateOpencodeAuthBundle, validateOpencodeCredentialRef } from "../src/engine/credentials/opencodeAuth.js";
import {
  buildOpencodeAuthMaterializationCommand,
  materializeOpencodeAuthBundle,
  opencodeDataHomeForRun,
} from "../src/engine/credentials/opencodeMaterializer.js";
import { buildApp } from "../src/main.js";

const target: SshTarget = {
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
      redacted: true,
    });
    expect(ssh.command).toContain(".credentials.json");
    expect(ssh.command).not.toContain("secret-token");
    expect(ssh.stdin).toBe(claudeJson);
  });

  it("builds a restrictive materialization command in umask→mkdir→cat→chmod order", () => {
    const command = buildClaudeAuthMaterializationCommand("/tmp/claude home");
    expect(command).toBe(
      "umask 077 && mkdir -p '/tmp/claude home' && " +
        "cat > '/tmp/claude home/.credentials.json' && chmod 600 '/tmp/claude home/.credentials.json'",
    );
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
      redacted: true,
    });
    expect(ssh.command).toContain("opencode/auth.json");
    expect(ssh.command).not.toContain("secret-zai-key");
    expect(ssh.stdin).toBe(opencodeJson);
  });

  it("builds a restrictive materialization command nesting auth.json under opencode/", () => {
    const command = buildOpencodeAuthMaterializationCommand("/tmp/oc home");
    expect(command).toBe(
      "umask 077 && mkdir -p '/tmp/oc home/opencode' && " +
        "cat > '/tmp/oc home/opencode/auth.json' && chmod 600 '/tmp/oc home/opencode/auth.json'",
    );
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

describe("provider expansion HTTP import", () => {
  it("imports Claude and opencode credentials through HTTP without echoing secrets", async () => {
    const secrets = new FakeSecretStore();
    const app = buildApp({
      pool: {} as never,
      helloDependencies: {} as never,
      secrets,
      vaultHealthCheck: async () => ({ ok: true, status: 200 }),
    });

    const claude = await app.request("/credentials/claude/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "credential/claude/http", authJson: claudeJson }),
    });
    expect(claude.status).toBe(201);
    expect(await claude.json()).toEqual({
      credentialKind: "claude_cli_auth",
      ref: "credential/claude/http",
      redacted: true,
    });

    const opencode = await app.request("/credentials/opencode/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "credential/opencode/http", authJson: opencodeJson }),
    });
    expect(opencode.status).toBe(201);
    expect(await opencode.json()).toEqual({
      credentialKind: "opencode_cli_auth",
      ref: "credential/opencode/http",
      redacted: true,
    });

    const rejected = await app.request("/credentials/opencode/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: "credential/opencode/bad",
        authJson: JSON.stringify({ wafer: { key: "x" } }),
      }),
    });
    expect(rejected.status).toBe(400);
  });
});

class CapturingSsh implements SshSubstrate {
  command = "";
  stdin: string | undefined;
  result: SshCommandResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false };

  async run(_target: SshTarget, command: SshCommand): Promise<SshCommandResult> {
    this.command = command.command;
    this.stdin = command.stdin;
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
    ).rejects.toThrow("Claude credential materialization failed with exit code 7");
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
