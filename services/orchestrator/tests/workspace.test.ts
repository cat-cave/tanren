import { describe, expect, it } from "vitest";
import type { SshTarget } from "../src/engine/contracts/allocator.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import { defineFailure } from "../src/engine/failure.js";
import { createFakeWriter } from "./fixtures/fakeWriter.js";
import { parseGitLogCommit, prepareGitWorkspace } from "./fixtures/workspaceGit.js";
import {
  bootstrapWorkspace,
  DEFAULT_BOOTSTRAP_COMMAND,
  runWorkspaceSshCommand,
  WorkspaceBootstrapError,
  WorkspaceCommandError,
  workspaceRepoPathForRun,
} from "../src/engine/workspace/index.js";

const target: SshTarget = {
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

describe("workspace git contract", () => {
  it("builds only run-scoped workspace paths", () => {
    expect(workspaceRepoPathForRun("run_1234-abcd")).toBe("/workspace/runs/run_1234-abcd/repo");
    expect(() => workspaceRepoPathForRun("spec_123")).toThrow("unsafe run id");
    expect(() => workspaceRepoPathForRun("run_../escape")).toThrow("unsafe run id");
    expect(() => workspaceRepoPathForRun("run_bad/path")).toThrow("unsafe run id");
  });

  it("turns nonzero, timeout, and substrate failures into workspace command errors", async () => {
    const nonzero = new ScriptedSsh([{ exitCode: 7, stdout: "", stderr: "bad", timedOut: false }]);
    await expect(
      runWorkspaceSshCommand(nonzero, target, {
        label: "git step",
        command: "git status",
        timeoutMs: 50,
      }),
    ).rejects.toThrow(WorkspaceCommandError);

    const timedOut = new ScriptedSsh([{ exitCode: null, stdout: "", stderr: "", timedOut: true }]);
    await expect(
      runWorkspaceSshCommand(timedOut, target, {
        label: "slow step",
        command: "sleep 10",
        timeoutMs: 50,
      }),
    ).rejects.toThrow("slow step timed out");

    const failed = new ScriptedSsh([
      {
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        failure: defineFailure({
          kind: "ssh_failed",
          target: "tanren@runner:22",
          message: "connection failed",
        }),
      },
    ]);
    await expect(
      runWorkspaceSshCommand(failed, target, { label: "ssh step", command: "true", timeoutMs: 50 }),
    ).rejects.toThrow("ssh step failed: connection failed");
  });

  it("parses captured git commit metadata", () => {
    expect(parseGitLogCommit("0123456789abcdef0123456789abcdef01234567\thello world\n")).toEqual({
      sha: "0123456789abcdef0123456789abcdef01234567",
      message: "hello world",
    });
    expect(() => parseGitLogCommit("not-a-sha\thello world\n")).toThrow("invalid sha");
    expect(() => parseGitLogCommit("0123456789abcdef0123456789abcdef01234567\n")).toThrow("separator");
  });

  it("prepares a repo and runs the fake writer through SSH git commands", async () => {
    const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const diff = "diff --git a/HELLO.md b/HELLO.md\nnew file mode 100644\n+hello world\n";
    const ssh = new ScriptedSsh([
      { exitCode: 0, stdout: "", stderr: "", timedOut: false },
      { exitCode: 0, stdout: "", stderr: "", timedOut: false },
      { exitCode: 0, stdout: diff, stderr: "", timedOut: false },
      { exitCode: 0, stdout: `${sha}\thello world\n`, stderr: "", timedOut: false },
    ]);
    const workspacePath = workspaceRepoPathForRun("run_git_contract");

    await prepareGitWorkspace({ ssh, target, workspacePath, timeoutMs: 100 });
    const writer = createFakeWriter({ ssh, target });
    const result = await writer.runWriter({
      prompt: "write",
      workspace: workspacePath,
      timeoutMs: 100,
    });

    expect(result.diff).toBe(diff);
    expect(result.commits).toEqual([{ sha, message: "hello world" }]);
    expect(ssh.commands.map((item) => item.command.cwd)).toEqual([
      undefined,
      workspacePath,
      workspacePath,
      workspacePath,
    ]);
    expect(ssh.commands[0]?.command.command).toContain("git init -b main");
    expect(ssh.commands[1]?.command.command).toContain("HELLO.md");
    expect(ssh.commands[2]?.command.command).toBe("git diff --no-color HEAD~1..HEAD");
    expect(ssh.commands[3]?.command.command).toBe("git log -1 --format='%H%x09%s' HEAD");
  });
});

describe("workspace bootstrap (P3-0006)", () => {
  const workspacePath = workspaceRepoPathForRun("run_bootstrap");

  it("runs the install command in the workspace dir and returns success", async () => {
    const ssh = new ScriptedSsh([{ exitCode: 0, stdout: "Packages: +120", stderr: "", timedOut: false }]);
    const result = await bootstrapWorkspace({
      ssh,
      target,
      workspacePath,
      command: "pnpm install",
      timeoutMs: 100,
    });

    expect(result.exitCode).toBe(0);
    expect(ssh.commands).toHaveLength(1);
    expect(ssh.commands[0]?.command.command).toBe("pnpm install");
    expect(ssh.commands[0]?.command.cwd).toBe(workspacePath);
  });

  it("falls back to the default pnpm/npm-detecting command when none is given", async () => {
    const ssh = new ScriptedSsh([{ exitCode: 0, stdout: "", stderr: "", timedOut: false }]);
    await bootstrapWorkspace({ ssh, target, workspacePath, timeoutMs: 100 });

    expect(ssh.commands[0]?.command.command).toBe(DEFAULT_BOOTSTRAP_COMMAND);
    expect(DEFAULT_BOOTSTRAP_COMMAND).toContain("pnpm install");
  });

  it("throws a typed WorkspaceBootstrapError with exit code + output tail on failure", async () => {
    const ssh = new ScriptedSsh([
      {
        exitCode: 1,
        stdout: "resolving",
        stderr: "ERR_PNPM_NO_LOCKFILE\nvitest: not found",
        timedOut: false,
      },
    ]);

    const error = await bootstrapWorkspace({
      ssh,
      target,
      workspacePath,
      command: "pnpm install",
      timeoutMs: 100,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkspaceBootstrapError);
    const typed = error as WorkspaceBootstrapError;
    expect(typed.exitCode).toBe(1);
    expect(typed.workspacePath).toBe(workspacePath);
    expect(typed.outputTail).toContain("vitest: not found");
    expect(typed.message).toContain("exited 1");
  });

  it("treats a timeout and a substrate failure as bootstrap errors", async () => {
    const timedOut = new ScriptedSsh([{ exitCode: null, stdout: "", stderr: "", timedOut: true }]);
    const timeoutError = await bootstrapWorkspace({
      ssh: timedOut,
      target,
      workspacePath,
      timeoutMs: 50,
    }).catch((caught: unknown) => caught);
    expect(timeoutError).toBeInstanceOf(WorkspaceBootstrapError);
    expect((timeoutError as WorkspaceBootstrapError).message).toContain("timed out");

    const failed = new ScriptedSsh([
      {
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        failure: defineFailure({
          kind: "ssh_failed",
          target: "tanren@runner:22",
          message: "connection reset",
        }),
      },
    ]);
    const substrateError = await bootstrapWorkspace({
      ssh: failed,
      target,
      workspacePath,
      timeoutMs: 50,
    }).catch((caught: unknown) => caught);
    expect(substrateError).toBeInstanceOf(WorkspaceBootstrapError);
    expect((substrateError as WorkspaceBootstrapError).outputTail).toContain("connection reset");
  });
});

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
