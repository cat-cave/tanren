import { readFile } from "node:fs/promises";
import type { ServerHostKeyAlgorithm } from "ssh2";
import { describe, expect, it } from "vitest";
import type { SshTarget } from "../src/engine/contracts/allocator.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { storeCodexAuthBundle } from "../src/engine/credentials/codexAuth.js";
import type { AuditAnswer, CheckAnswer } from "../src/engine/providers/answererSchemas.js";
import { createCodexAnswerer } from "../src/engine/providers/codex.js";
import { Ssh2Substrate } from "../src/engine/ssh/index.js";
import { runWorkspaceSshCommand, workspaceRepoPathForRun } from "../src/engine/workspace/index.js";
import { prepareGitWorkspace } from "./fixtures/workspaceGit.js";
import { executeStructuredAuditTask, executeStructuredCheckTask } from "../src/engine/workflow/answererTasks.js";

const runLive = process.env.TANREN_CODEX_ANSWERER_LIVE === "1";
const describeLive = runLive ? describe : describe.skip;

describeLive("live Codex Answerer adapter", () => {
  it(
    "materializes managed auth and returns a structured check answer for a fixture diff",
    async () => {
      const timeoutMs = Number(process.env.TANREN_CODEX_LIVE_TIMEOUT_MS ?? "300000");
      const authPath = requireEnv("TANREN_CODEX_AUTH_JSON_FILE");
      const secrets = new InMemorySecretStore();
      await storeCodexAuthBundle(secrets, {
        ref: "credential/codex/answerer-live",
        authJson: await readFile(authPath, "utf8"),
      });
      await secrets.put({
        ref: "runner/live/identity",
        value: await readFile(requireEnv("TANREN_SSH_KEY_PATH"), "utf8"),
      });
      const ssh = new Ssh2Substrate(secrets, {
        serverHostKeyAlgorithms: parseHostKeyAlgorithms(process.env.TANREN_SSH_HOST_KEY_ALGORITHMS),
      });
      const target = liveTarget();
      const runId = `run_codex_answerer_live_${Date.now()}`;
      const workspace = workspaceRepoPathForRun(runId);
      await prepareGitWorkspace({ ssh, target, workspacePath: workspace, timeoutMs: 30_000 });
      // The Answerer now inspects the change itself, so the change must actually
      // live in the workspace: capture the baseline sha, then commit the real
      // README marker the criteria reference.
      const baselineSha = await captureBaselineHead(ssh, target, workspace);
      await commitReadmeMarker(ssh, target, workspace);
      const beforeStatus = await gitStatus(ssh, target, workspace);

      const checker = createCodexAnswerer<CheckAnswer>({
        secrets,
        ssh,
        target,
        credentialRef: "credential/codex/answerer-live",
        runId: `${runId}_check`,
      });

      const check = await executeStructuredCheckTask(checker, {
        specTitle: "Fixture check",
        specDescription: "README should gain a success marker.",
        acceptanceCriteria: ["README.md contains the line tanren answerer ok"],
        baselineSha,
        timeoutMs,
        workspace,
      });
      const auditor = createCodexAnswerer<AuditAnswer>({
        secrets,
        ssh,
        target,
        credentialRef: "credential/codex/answerer-live",
        runId: `${runId}_audit`,
      });
      const audit = await executeStructuredAuditTask(auditor, {
        specTitle: "Fixture check",
        acceptanceCriteria: ["README.md contains the line tanren answerer ok"],
        checkAnswer: check,
        baselineSha,
        timeoutMs,
        workspace,
      });
      const afterStatus = await gitStatus(ssh, target, workspace);

      expect(check.done).toBe(true);
      expect(check.reason.length).toBeGreaterThan(0);
      expect(audit.verified).toBe(true);
      expect(audit.criteria_status.criteria[0]?.satisfied).toBe(true);
      expect(afterStatus.stdout).toBe(beforeStatus.stdout);
    },
    Number(process.env.TANREN_CODEX_LIVE_TIMEOUT_MS ?? "300000") * 2 + 20_000,
  );
});

async function captureBaselineHead(ssh: Ssh2Substrate, target: SshTarget, workspace: string): Promise<string> {
  const result = await runWorkspaceSshCommand(ssh, target, {
    label: "capture baseline head",
    cwd: workspace,
    command: "git rev-parse HEAD",
    timeoutMs: 30_000,
  });
  return result.stdout.trim();
}

async function commitReadmeMarker(ssh: Ssh2Substrate, target: SshTarget, workspace: string): Promise<void> {
  await runWorkspaceSshCommand(ssh, target, {
    label: "commit readme marker",
    cwd: workspace,
    command: [
      "set -eu",
      "printf '%s\\n' '# Tanren workspace baseline' 'tanren answerer ok' > README.md",
      "git add README.md",
      "GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z' git commit -m 'add answerer marker'",
    ].join(" && "),
    timeoutMs: 30_000,
  });
}

async function gitStatus(ssh: Ssh2Substrate, target: SshTarget, workspace: string) {
  return await runWorkspaceSshCommand(ssh, target, {
    label: "read answerer workspace status",
    cwd: workspace,
    command: "git status --short",
    timeoutMs: 30_000,
  });
}

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
