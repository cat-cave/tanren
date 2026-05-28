import { describe, expect, it } from "vitest";
import type { SshTarget } from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import {
  storeClaudeAuthBundle,
  validateClaudeAuthBundle,
  validateClaudeCredentialRef
} from "../src/engine/credentials/claudeAuth.js";
import {
  buildClaudeAuthMaterializationCommand,
  materializeClaudeAuthBundle
} from "../src/engine/credentials/claudeMaterializer.js";
import {
  validateOpencodeAuthBundle,
  validateOpencodeCredentialRef
} from "../src/engine/credentials/opencodeAuth.js";
import {
  buildOpencodeAuthMaterializationCommand,
  materializeOpencodeAuthBundle
} from "../src/engine/credentials/opencodeMaterializer.js";
import { buildApp } from "../src/main.js";

const target: SshTarget = {
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU",
  identitySecretRef: "runner/local/identity"
};

const claudeJson = JSON.stringify({ claudeAiOauth: { accessToken: "secret-token", refreshToken: "refresh" } });
const opencodeJson = JSON.stringify({ zai: { key: "secret-zai-key" } });

describe("Claude credential contracts", () => {
  it("validates the OAuth bundle and returns only a redacted import result", async () => {
    const secrets = new FakeSecretStore();
    const result = await storeClaudeAuthBundle(secrets, { ref: "credential/claude/dev", authJson: claudeJson });
    expect(result).toEqual({ credentialKind: "claude_cli_auth", ref: "credential/claude/dev", redacted: true });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("accepts a raw API key bundle and rejects non-Claude JSON and namespaces", () => {
    expect(validateClaudeAuthBundle(JSON.stringify({ ANTHROPIC_API_KEY: "sk-ant" })).authJson).toContain("ANTHROPIC_API_KEY");
    expect(() => validateClaudeAuthBundle("{}")).toThrow("must not be empty");
    expect(() => validateClaudeAuthBundle(JSON.stringify({ ok: true }))).toThrow("Claude CLI token fields");
    expect(() => validateClaudeCredentialRef("credential/codex/dev")).toThrow("credential/claude/");
  });

  it("materializes credentials into a per-run CLAUDE_CONFIG_DIR without returning secrets", async () => {
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/claude/dev", value: claudeJson });
    const ssh = new CapturingSsh();
    const result = await materializeClaudeAuthBundle({ secrets, ssh, target, ref: "credential/claude/dev", runId: "run_123" });
    expect(result).toEqual({
      CLAUDE_CONFIG_DIR: "/home/tanren/.tanren/runs/run_123/claude-home",
      ref: "credential/claude/dev",
      redacted: true
    });
    expect(ssh.command).toContain(".credentials.json");
    expect(ssh.command).not.toContain("secret-token");
    expect(ssh.stdin).toBe(claudeJson);
  });

  it("builds a restrictive materialization command", () => {
    const command = buildClaudeAuthMaterializationCommand("/tmp/claude home");
    expect(command).toContain("umask 077");
    expect(command).toContain("chmod 600 '/tmp/claude home/.credentials.json'");
  });
});

describe("opencode credential contracts", () => {
  it("requires a Zai GLM provider entry and rejects non-opencode namespaces", () => {
    expect(validateOpencodeAuthBundle(opencodeJson).authJson).toContain("zai");
    expect(() => validateOpencodeAuthBundle(JSON.stringify({ wafer: { key: "x" } }))).toThrow("Zai GLM provider entry");
    expect(() => validateOpencodeAuthBundle("{}")).toThrow("must not be empty");
    expect(() => validateOpencodeCredentialRef("credential/claude/dev")).toThrow("credential/opencode/");
  });

  it("materializes auth.json into a per-run XDG_DATA_HOME without returning secrets", async () => {
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/opencode/dev", value: opencodeJson });
    const ssh = new CapturingSsh();
    const result = await materializeOpencodeAuthBundle({ secrets, ssh, target, ref: "credential/opencode/dev", runId: "run_123" });
    expect(result).toEqual({
      XDG_DATA_HOME: "/home/tanren/.tanren/runs/run_123/opencode-home",
      ref: "credential/opencode/dev",
      redacted: true
    });
    expect(ssh.command).toContain("opencode/auth.json");
    expect(ssh.command).not.toContain("secret-zai-key");
    expect(ssh.stdin).toBe(opencodeJson);
  });

  it("builds a restrictive materialization command", () => {
    const command = buildOpencodeAuthMaterializationCommand("/tmp/oc home");
    expect(command).toContain("umask 077");
    expect(command).toContain("chmod 600 '/tmp/oc home/opencode/auth.json'");
  });
});

describe("provider expansion HTTP import", () => {
  it("imports Claude and opencode credentials through HTTP without echoing secrets", async () => {
    const secrets = new FakeSecretStore();
    const app = buildApp({
      pool: {} as never,
      helloDependencies: {} as never,
      secrets,
      vaultHealthCheck: async () => ({ ok: true, status: 200 })
    });

    const claude = await app.request("/credentials/claude/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "credential/claude/http", authJson: claudeJson })
    });
    expect(claude.status).toBe(201);
    expect(await claude.json()).toEqual({ credentialKind: "claude_cli_auth", ref: "credential/claude/http", redacted: true });

    const opencode = await app.request("/credentials/opencode/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "credential/opencode/http", authJson: opencodeJson })
    });
    expect(opencode.status).toBe(201);
    expect(await opencode.json()).toEqual({ credentialKind: "opencode_cli_auth", ref: "credential/opencode/http", redacted: true });

    const rejected = await app.request("/credentials/opencode/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "credential/opencode/bad", authJson: JSON.stringify({ wafer: { key: "x" } }) })
    });
    expect(rejected.status).toBe(400);
  });
});

class CapturingSsh implements SshSubstrate {
  command = "";
  stdin: string | undefined;

  async run(_target: SshTarget, command: SshCommand): Promise<SshCommandResult> {
    this.command = command.command;
    this.stdin = command.stdin;
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}
