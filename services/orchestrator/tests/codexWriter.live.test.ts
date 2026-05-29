import { readFile } from "node:fs/promises";
import type { ServerHostKeyAlgorithm } from "ssh2";
import { describe, expect, it } from "vitest";
import type { SshTarget } from "../src/engine/contracts/allocator.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { storeCodexAuthBundle } from "../src/engine/credentials/codexAuth.js";
import { createCodexWriter } from "../src/engine/providers/codex.js";
import { Ssh2Substrate } from "../src/engine/ssh/index.js";
import { prepareGitWorkspace, runWorkspaceSshCommand, workspaceRepoPathForRun } from "../src/engine/workspace/index.js";

const runLive = process.env.TANREN_CODEX_LIVE === "1";
const describeLive = runLive ? describe : describe.skip;

describeLive("live Codex writer adapter", () => {
  it(
    "materializes managed auth and makes a tiny mutation in a runner workspace",
    async () => {
      const timeoutMs = Number(process.env.TANREN_CODEX_LIVE_TIMEOUT_MS ?? "300000");
      const authPath = requireEnv("TANREN_CODEX_AUTH_JSON_FILE");
      const secrets = new InMemorySecretStore();
      await storeCodexAuthBundle(secrets, {
        ref: "credential/codex/live",
        authJson: await readFile(authPath, "utf8"),
      });
      await secrets.put({
        ref: "runner/live/identity",
        value: await readFile(requireEnv("TANREN_SSH_KEY_PATH"), "utf8"),
      });
      const target = liveTarget();
      const ssh = new Ssh2Substrate(secrets, {
        serverHostKeyAlgorithms: parseHostKeyAlgorithms(process.env.TANREN_SSH_HOST_KEY_ALGORITHMS),
      });
      const runId = `run_codex_live_${Date.now()}`;
      const workspace = workspaceRepoPathForRun(runId);

      await prepareGitWorkspace({ ssh, target, workspacePath: workspace, timeoutMs: 30_000 });
      const writer = createCodexWriter({
        secrets,
        ssh,
        target,
        credentialRef: "credential/codex/live",
        runId,
      });
      const result = await writer.runWriter({
        prompt: "Create LIVE_CODEX.md containing exactly: codex live writer ok",
        workspace,
        timeoutMs,
      });
      const file = await runWorkspaceSshCommand(ssh, target, {
        label: "read live codex fixture",
        cwd: workspace,
        command: "cat LIVE_CODEX.md",
        timeoutMs: 30_000,
      });

      expect(result.exitReason).toBe("completed");
      expect(result.diff).toContain("LIVE_CODEX.md");
      expect(result.commits).toEqual([expect.objectContaining({ message: "codex writer" })]);
      expect(result.telemetry?.rawEventCount).toBeGreaterThan(0);
      expect(file.stdout.trim()).toBe("codex live writer ok");
    },
    Number(process.env.TANREN_CODEX_LIVE_TIMEOUT_MS ?? "300000") + 10_000,
  );
});

function liveTarget(): SshTarget {
  return {
    host: process.env.TANREN_SSH_HOST ?? "127.0.0.1",
    port: Number(process.env.TANREN_SSH_PORT ?? "2222"),
    username: process.env.TANREN_SSH_USER ?? "tanren",
    hostKeyFingerprint: requireEnv("TANREN_SSH_HOST_FINGERPRINT"),
    identitySecretRef: "runner/live/identity",
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parseHostKeyAlgorithms(value: string | undefined): ServerHostKeyAlgorithm[] | undefined {
  return value
    ?.split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "") as ServerHostKeyAlgorithm[] | undefined;
}
