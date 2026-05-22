import type { SshTarget } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { SshSubstrate } from "../contracts/sshSubstrate.js";
import { storeCodexAuthBundle } from "../credentials/codexAuth.js";
import { materializeCodexAuthBundle } from "../credentials/codexMaterializer.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { runWorkspaceSshCommand } from "../workspace/index.js";
import type { Commit, TokenUsage, WriterAdapter, WriterResult } from "./types.js";

export interface CodexWriterDependencies {
  secrets: SecretStore;
  ssh: SshSubstrate;
  target: SshTarget;
  credentialRef: string;
  runId: string;
  codexHomeBaseDir?: string;
}

export interface CodexEventTelemetry {
  rawEventCount: number;
  tokenUsage?: TokenUsage;
}

export function createCodexWriter(dependencies: CodexWriterDependencies): WriterAdapter {
  return {
    kind: "writer",
    cli: "codex",
    async runWriter(opts): Promise<WriterResult> {
      const auth = await materializeCodexAuthBundle({
        secrets: dependencies.secrets,
        ssh: dependencies.ssh,
        target: dependencies.target,
        ref: dependencies.credentialRef,
        runId: dependencies.runId,
        baseDir: dependencies.codexHomeBaseDir,
        timeoutMs: Math.min(opts.timeoutMs, 30_000)
      });
      const baselineSha = await captureBaselineSha(dependencies.ssh, dependencies.target, opts.workspace, opts.timeoutMs);
      const codex = await dependencies.ssh.run(dependencies.target, {
        command: buildCodexExecCommand({ codexHome: auth.CODEX_HOME, workspace: opts.workspace }),
        stdin: opts.prompt,
        timeoutMs: opts.timeoutMs
      });
      const telemetry = parseCodexJsonlTelemetry(codex.stdout);
      await persistRefreshedCodexAuthBestEffort({
        secrets: dependencies.secrets,
        ssh: dependencies.ssh,
        target: dependencies.target,
        ref: dependencies.credentialRef,
        codexHome: auth.CODEX_HOME,
        timeoutMs: Math.min(opts.timeoutMs, 30_000)
      });

      const gitState = await captureGitStateAfterCodex(dependencies.ssh, dependencies.target, opts.workspace, baselineSha, opts.timeoutMs);
      if (codex.timedOut) {
        return failedResult("timeout", telemetry, gitState);
      }
      if (codex.failure !== undefined || codex.exitCode !== 0) {
        return failedResult("crashed", telemetry, gitState);
      }

      return {
        ...gitState,
        exitReason: "completed",
        tokenUsage: telemetry.tokenUsage,
        telemetry
      };
    }
  };
}

async function persistRefreshedCodexAuthBestEffort(input: {
  secrets: SecretStore;
  ssh: SshSubstrate;
  target: SshTarget;
  ref: string;
  codexHome: string;
  timeoutMs: number;
}): Promise<void> {
  const result = await input.ssh.run(input.target, {
    command: `cat ${quoteSshShellArg(`${input.codexHome}/auth.json`)}`,
    timeoutMs: input.timeoutMs
  });
  if (result.exitCode !== 0 || result.timedOut || result.failure !== undefined) {
    return;
  }
  try {
    await storeCodexAuthBundle(input.secrets, { ref: input.ref, authJson: result.stdout });
  } catch {
    return;
  }
}

export function buildCodexExecCommand(input: { codexHome: string; workspace: string }): string {
  return [
    `CODEX_HOME=${quoteSshShellArg(input.codexHome)}`,
    "codex exec",
    "--sandbox workspace-write",
    "--json",
    "--ignore-user-config",
    "--cd",
    quoteSshShellArg(input.workspace),
    "-"
  ].join(" ");
}

export function parseCodexJsonlTelemetry(stdout: string): CodexEventTelemetry {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
  let tokenUsage: TokenUsage | undefined;
  for (const line of lines) {
    const parsed = parseJsonObject(line);
    if (parsed === undefined) {
      continue;
    }
    tokenUsage = findTokenUsage(parsed) ?? tokenUsage;
  }
  return { rawEventCount: lines.length, tokenUsage };
}

function parseJsonObject(line: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function findTokenUsage(value: unknown): TokenUsage | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const usage = tokenUsageFromRecord(record);
  if (usage !== undefined) {
    return usage;
  }
  for (const child of Object.values(record)) {
    const nested = findTokenUsage(child);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

function tokenUsageFromRecord(record: Record<string, unknown>): TokenUsage | undefined {
  const inputTokens = numberField(record, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]);
  const outputTokens = numberField(record, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]);
  const cachedTokens = numberField(record, ["cached_tokens", "cachedTokens", "cache_read_input_tokens", "cachedInputTokens"]) ?? 0;
  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined;
  }
  return { inputTokens, outputTokens, cachedTokens };
}

function numberField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

async function captureBaselineSha(ssh: SshSubstrate, target: SshTarget, workspace: string, timeoutMs: number): Promise<string> {
  const result = await runWorkspaceSshCommand(ssh, target, {
    label: "capture baseline git sha",
    cwd: workspace,
    command: "git rev-parse HEAD",
    timeoutMs
  });
  const sha = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`baseline git capture returned invalid sha: ${sha}`);
  }
  return sha;
}

async function commitWorkspaceChangesAfterCodex(
  ssh: SshSubstrate,
  target: SshTarget,
  workspace: string,
  timeoutMs: number
): Promise<void> {
  await runWorkspaceSshCommand(ssh, target, {
    label: "commit codex workspace changes",
    cwd: workspace,
    command: [
      "set -eu",
      "git add -A",
      "if ! git diff --cached --quiet --exit-code; then",
      "GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z' git commit -m 'codex writer'",
      "fi"
    ].join("\n"),
    timeoutMs
  });
}

async function captureGitStateAfterCodex(
  ssh: SshSubstrate,
  target: SshTarget,
  workspace: string,
  baselineSha: string,
  timeoutMs: number
): Promise<Pick<WriterResult, "diff" | "commits">> {
  await commitWorkspaceChangesAfterCodex(ssh, target, workspace, timeoutMs);
  return await captureGitStateAfterBaseline(ssh, target, workspace, baselineSha, timeoutMs);
}

async function captureGitStateAfterBaseline(
  ssh: SshSubstrate,
  target: SshTarget,
  workspace: string,
  baselineSha: string,
  timeoutMs: number
): Promise<Pick<WriterResult, "diff" | "commits">> {
  const diff = await runWorkspaceSshCommand(ssh, target, {
    label: "capture codex git diff",
    cwd: workspace,
    command: `git diff --no-color ${baselineSha}`,
    timeoutMs
  });
  const log = await runWorkspaceSshCommand(ssh, target, {
    label: "capture codex git commits",
    cwd: workspace,
    command: `git log --format='%H%x09%s' --reverse ${baselineSha}..HEAD`,
    timeoutMs
  });
  return { diff: diff.stdout, commits: parseGitLogCommits(log.stdout) };
}

function parseGitLogCommits(stdout: string): Commit[] {
  return stdout
    .trimEnd()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const separator = line.indexOf("\t");
      if (separator === -1) {
        throw new Error("git commit capture did not include sha/message separator");
      }
      const sha = line.slice(0, separator);
      const message = line.slice(separator + 1);
      if (!/^[0-9a-f]{40}$/.test(sha)) {
        throw new Error(`git commit capture returned invalid sha: ${sha}`);
      }
      if (message === "") {
        throw new Error("git commit capture returned an empty commit message");
      }
      return { sha, message };
    });
}

function failedResult(
  exitReason: "timeout" | "crashed",
  telemetry: CodexEventTelemetry,
  gitState: Pick<WriterResult, "diff" | "commits">
): WriterResult {
  return { ...gitState, exitReason, tokenUsage: telemetry.tokenUsage, telemetry };
}
