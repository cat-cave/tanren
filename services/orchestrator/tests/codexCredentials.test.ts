import { describe, expect, it } from "vitest";
import type { SshTarget } from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import {
  storeCodexAuthBundle,
  validateCodexAuthBundle,
  validateCodexCredentialRef,
  validateCredentialRef,
} from "../src/engine/credentials/codexAuth.js";
import {
  buildCodexAuthMaterializationCommand,
  materializeCodexAuthBundle,
} from "../src/engine/credentials/codexMaterializer.js";
import { buildApp } from "../src/main.js";

const target: SshTarget = {
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU",
  identitySecretRef: "runner/local/identity",
};

describe("Codex credential contracts", () => {
  it("validates auth JSON and returns only a redacted import result", async () => {
    const secrets = new FakeSecretStore();
    const authJson = JSON.stringify({ tokens: { access_token: "secret-token" } });

    const result = await storeCodexAuthBundle(secrets, { ref: "credential/codex/dev", authJson });

    expect(result).toEqual({
      credentialKind: "codex_chatgpt_auth",
      ref: "credential/codex/dev",
      redacted: true,
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
    await expect(secrets.get("credential/codex/dev")).resolves.toEqual({
      ref: "credential/codex/dev",
      value: authJson,
    });
  });

  it("rejects invalid auth JSON and implicit-looking refs", () => {
    expect(() => validateCodexAuthBundle("{}")).toThrow("must not be empty");
    expect(() => validateCodexAuthBundle("not-json")).toThrow("valid JSON");
    expect(() => validateCredentialRef("../.codex/auth.json")).toThrow("explicit managed ref");
    expect(() => validateCredentialRef("credential/../codex")).toThrow("relative path segments");
  });

  it("materializes auth.json into a per-run CODEX_HOME over SSH without returning secrets", async () => {
    const secrets = new FakeSecretStore();
    const authJson = JSON.stringify({ tokens: { access_token: "secret-token" } });
    await secrets.put({ ref: "credential/codex/dev", value: authJson });
    const ssh = new CapturingSshSubstrate();

    const result = await materializeCodexAuthBundle({
      secrets,
      ssh,
      target,
      ref: "credential/codex/dev",
      runId: "run_123",
    });

    expect(result).toEqual({
      CODEX_HOME: "/home/tanren/.tanren/runs/run_123/codex-home",
      ref: "credential/codex/dev",
      redacted: true,
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(ssh.command).toContain("mkdir -p '/home/tanren/.tanren/runs/run_123/codex-home'");
    expect(ssh.command).toContain("auth.json");
    expect(ssh.command).not.toContain("secret-token");
    expect(ssh.command).not.toContain(Buffer.from(authJson, "utf8").toString("base64"));
    expect(ssh.stdin).toBe(authJson);
  });

  it("builds a restrictive materialization command", () => {
    const command = buildCodexAuthMaterializationCommand("/tmp/codex home");

    expect(command).toContain("umask 077");
    expect(command).toContain("cat > '/tmp/codex home/auth.json'");
    expect(command).toContain("chmod 600 '/tmp/codex home/auth.json'");
  });

  it("rejects non-Codex JSON and non-Codex credential namespaces", () => {
    expect(() => validateCodexAuthBundle('{"ok":true}')).toThrow("Codex ChatGPT token fields");
    expect(() => validateCodexCredentialRef("runner/local-docker/identity")).toThrow("credential/codex/");
  });

  it("imports Codex credentials through HTTP without echoing secret values", async () => {
    const secrets = new FakeSecretStore();
    const app = buildApp({
      pool: {} as never,
      helloDependencies: {} as never,
      secrets,
      vaultHealthCheck: async () => ({ ok: true, status: 200 }),
    });
    const response = await app.request("/credentials/codex/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: "credential/codex/http",
        authJson: JSON.stringify({ tokens: { access_token: "secret-token" } }),
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({
      credentialKind: "codex_chatgpt_auth",
      ref: "credential/codex/http",
      redacted: true,
    });
    expect(JSON.stringify(body)).not.toContain("secret-token");
  });
});

class CapturingSshSubstrate implements SshSubstrate {
  command = "";
  stdin: string | undefined;

  async run(_target: SshTarget, command: SshCommand): Promise<SshCommandResult> {
    this.command = command.command;
    this.stdin = command.stdin;
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}
