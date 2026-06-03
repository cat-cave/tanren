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
  codexHomeForRun,
  materializeCodexAuthBundle,
} from "../src/engine/credentials/codexMaterializer.js";

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

  it("builds a restrictive materialization command in umask→mkdir→cat→chmod order", () => {
    const command = buildCodexAuthMaterializationCommand("/tmp/codex home");

    expect(command).toBe(
      "umask 077 && mkdir -p '/tmp/codex home' && " +
        "cat > '/tmp/codex home/auth.json' && chmod 600 '/tmp/codex home/auth.json'",
    );
  });

  it("materializes a MANAGED OpenRouter API key as codex API-key auth.json (no codex-bundle validation)", async () => {
    const secrets = new FakeSecretStore();
    // A managed run's stored secret is a PLAIN OpenRouter key string, NOT a
    // codex auth-bundle JSON, under a non-codex provider ref.
    await secrets.put({ ref: "credential/openrouter/platform/default", value: "sk-or-v1-managed-key" });
    const ssh = new CapturingSshSubstrate();

    const result = await materializeCodexAuthBundle({
      secrets,
      ssh,
      target,
      ref: "credential/openrouter/platform/default",
      runId: "run_managed_1",
      managed: true,
    });

    // The validated ref is returned verbatim (the codex-ref validator is NOT
    // applied — it would reject this non-codex ref).
    expect(result).toEqual({
      CODEX_HOME: "/home/tanren/.tanren/runs/run_managed_1/codex-home",
      ref: "credential/openrouter/platform/default",
      redacted: true,
    });
    // The auth.json materialized over SSH is codex's API-key shape, carrying the
    // raw key under OPENAI_API_KEY (codex authenticates with this against the
    // managed OPENAI_BASE_URL endpoint).
    expect(ssh.stdin).toBe(JSON.stringify({ OPENAI_API_KEY: "sk-or-v1-managed-key" }));
    expect(ssh.command).toContain("auth.json");
    // The redacted result never carries the key.
    expect(JSON.stringify(result)).not.toContain("sk-or-v1-managed-key");
  });

  it("MANAGED mode does NOT apply the codex-bundle validator: a raw key (non-JSON) is accepted", async () => {
    const secrets = new FakeSecretStore();
    // A raw key is not valid JSON and would fail validateCodexAuthBundle — the
    // managed path must NOT run it.
    await secrets.put({ ref: "credential/anthropic/platform/default", value: "sk-ant-managed" });
    const ssh = new CapturingSshSubstrate();

    const result = await materializeCodexAuthBundle({
      secrets,
      ssh,
      target,
      ref: "credential/anthropic/platform/default",
      runId: "run_managed_2",
      managed: true,
    });

    expect(result.ref).toBe("credential/anthropic/platform/default");
    expect(ssh.stdin).toBe(JSON.stringify({ OPENAI_API_KEY: "sk-ant-managed" }));
  });

  it("MANAGED mode rejects a missing or whitespace-only api key loudly", async () => {
    const secrets = new FakeSecretStore();
    const ssh = new CapturingSshSubstrate();
    // Missing ref.
    await expect(
      materializeCodexAuthBundle({
        secrets,
        ssh,
        target,
        ref: "credential/openrouter/platform/default",
        runId: "run_managed_3",
        managed: true,
      }),
    ).rejects.toThrow("missing managed LLM credential ref: credential/openrouter/platform/default");
    // Whitespace-only key.
    await secrets.put({ ref: "credential/openrouter/platform/blank", value: "   " });
    await expect(
      materializeCodexAuthBundle({
        secrets,
        ssh,
        target,
        ref: "credential/openrouter/platform/blank",
        runId: "run_managed_4",
        managed: true,
      }),
    ).rejects.toThrow("resolved to an empty api key");
  });

  it("BYOK mode (managed unset/false) still REQUIRES + validates a codex bundle ref", async () => {
    const secrets = new FakeSecretStore();
    const ssh = new CapturingSshSubstrate();
    // A non-codex ref is rejected by the codex-ref validator under BYOK.
    await secrets.put({ ref: "credential/openrouter/platform/default", value: "sk-or-v1-x" });
    await expect(
      materializeCodexAuthBundle({
        secrets,
        ssh,
        target,
        ref: "credential/openrouter/platform/default",
        runId: "run_byok_1",
      }),
    ).rejects.toThrow("Codex credential ref must start with credential/codex/");
    // A codex ref whose value is a raw key (not a bundle) is rejected by the
    // bundle validator under BYOK (proving the bundle check still runs).
    await secrets.put({ ref: "credential/codex/dev", value: "sk-not-a-bundle" });
    await expect(
      materializeCodexAuthBundle({
        secrets,
        ssh,
        target,
        ref: "credential/codex/dev",
        runId: "run_byok_2",
        managed: false,
      }),
    ).rejects.toThrow("Codex auth bundle must be valid JSON");
  });

  it("throws when the credential ref is missing and derives a per-run CODEX_HOME", async () => {
    const secrets = new FakeSecretStore();
    const ssh = new CapturingSshSubstrate();
    await expect(
      materializeCodexAuthBundle({ secrets, ssh, target, ref: "credential/codex/dev", runId: "run_1" }),
    ).rejects.toThrow("missing Codex credential ref: credential/codex/dev");
    expect(ssh.command).toBe("");
    expect(codexHomeForRun("run_2", "/base/")).toBe("/base/run_2/codex-home");
    expect(() => codexHomeForRun("bad/id")).toThrow("run id is not safe");
  });

  it("rejects non-Codex JSON and non-Codex credential namespaces", () => {
    expect(() => validateCodexAuthBundle('{"ok":true}')).toThrow("Codex ChatGPT token fields");
    expect(() => validateCodexCredentialRef("runner/local-docker/identity")).toThrow("credential/codex/");
  });

  it("rejects JSON arrays and the literal null bundle", () => {
    expect(() => validateCodexAuthBundle("[]")).toThrow("must be a JSON object");
    expect(() => validateCodexAuthBundle("null")).toThrow("must be a JSON object");
  });

  it("accepts a bundle keyed by auth_mode + a token, an OPENAI_API_KEY, or a bare refresh_token", () => {
    expect(
      validateCodexAuthBundle(JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: "x" } })).authJson,
    ).toContain("auth_mode");
    expect(validateCodexAuthBundle(JSON.stringify({ OPENAI_API_KEY: "sk-1" })).authJson).toContain("OPENAI_API_KEY");
    expect(validateCodexAuthBundle(JSON.stringify({ tokens: { refresh_token: "r" } })).authJson).toContain(
      "refresh_token",
    );
  });

  it("rejects an empty OPENAI_API_KEY and empty token fields", () => {
    expect(() => validateCodexAuthBundle(JSON.stringify({ OPENAI_API_KEY: "" }))).toThrow("Codex ChatGPT token fields");
    expect(() => validateCodexAuthBundle(JSON.stringify({ tokens: { access_token: "" } }))).toThrow(
      "Codex ChatGPT token fields",
    );
    // `tokens` that is not an object must not satisfy the token check.
    expect(() => validateCodexAuthBundle(JSON.stringify({ auth_mode: "chatgpt", tokens: "nope" }))).toThrow(
      "Codex ChatGPT token fields",
    );
  });

  it("enforces the managed-ref grammar precisely", () => {
    // A leading punctuation char is not allowed (first char must be alnum).
    expect(() => validateCredentialRef("/credential/codex/dev")).toThrow("explicit managed ref");
    expect(() => validateCredentialRef("-credential/codex/dev")).toThrow("explicit managed ref");
    // Doubled slashes are rejected even though each char is otherwise legal.
    expect(() => validateCredentialRef("credential//codex/dev")).toThrow("explicit managed ref");
    // Spaces and other punctuation are rejected.
    expect(() => validateCredentialRef("credential/codex/de v")).toThrow("explicit managed ref");
    // A valid ref is returned verbatim.
    expect(validateCredentialRef("credential/codex/org/o1/default")).toBe("credential/codex/org/o1/default");
    // Over the 200-char cap is rejected.
    expect(() => validateCredentialRef("c" + "a".repeat(200))).toThrow("explicit managed ref");
    // Exactly 200 chars is accepted (1 lead + 199 tail).
    expect(validateCredentialRef("c" + "a".repeat(199))).toHaveLength(200);
  });

  it("rejects refs whose own segments are relative even when characters are legal", () => {
    expect(() => validateCredentialRef("credential/codex/..")).toThrow("relative path segments");
    expect(() => validateCredentialRef("a/./b")).toThrow("relative path segments");
  });

  it("stores under the validated ref and never mutates the secret value", async () => {
    const secrets = new FakeSecretStore();
    const authJson = JSON.stringify({ tokens: { access_token: "tok-1" } });
    const result = await storeCodexAuthBundle(secrets, { ref: "credential/codex/org/o1/k", authJson });
    expect(result.ref).toBe("credential/codex/org/o1/k");
    const stored = await secrets.get("credential/codex/org/o1/k");
    // The stored value is the canonicalized bundle JSON, byte-identical input here.
    expect(stored?.value).toBe(authJson);
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
