import { describe, expect, it } from "vitest";
import type { SshTarget } from "../src/engine/contracts/allocator.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import { defineFailure } from "../src/engine/failure.js";
import { createFakeWriter } from "../src/engine/providers/fake.js";
import {
  parseGitLogCommit,
  prepareGitWorkspace,
  runWorkspaceSshCommand,
  WorkspaceCommandError,
  workspaceRepoPathForRun
} from "../src/engine/workspace/index.js";

const target: SshTarget = {
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity"
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
    await expect(runWorkspaceSshCommand(nonzero, target, { label: "git step", command: "git status", timeoutMs: 50 })).rejects.toThrow(
      WorkspaceCommandError
    );

    const timedOut = new ScriptedSsh([{ exitCode: null, stdout: "", stderr: "", timedOut: true }]);
    await expect(runWorkspaceSshCommand(timedOut, target, { label: "slow step", command: "sleep 10", timeoutMs: 50 })).rejects.toThrow(
      "slow step timed out"
    );

    const failed = new ScriptedSsh([
      {
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        failure: defineFailure({ kind: "ssh_failed", target: "tanren@runner:22", message: "connection failed" })
      }
    ]);
    await expect(runWorkspaceSshCommand(failed, target, { label: "ssh step", command: "true", timeoutMs: 50 })).rejects.toThrow(
      "ssh step failed: connection failed"
    );
  });

  it("parses captured git commit metadata", () => {
    expect(parseGitLogCommit("0123456789abcdef0123456789abcdef01234567\thello world\n")).toEqual({
      sha: "0123456789abcdef0123456789abcdef01234567",
      message: "hello world"
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
      { exitCode: 0, stdout: `${sha}\thello world\n`, stderr: "", timedOut: false }
    ]);
    const workspacePath = workspaceRepoPathForRun("run_git_contract");

    await prepareGitWorkspace({ ssh, target, workspacePath, timeoutMs: 100 });
    const writer = createFakeWriter({ ssh, target });
    const result = await writer.runWriter({ prompt: "write", workspace: workspacePath, timeoutMs: 100 });

    expect(result.diff).toBe(diff);
    expect(result.commits).toEqual([{ sha, message: "hello world" }]);
    expect(ssh.commands.map((item) => item.command.cwd)).toEqual([undefined, workspacePath, workspacePath, workspacePath]);
    expect(ssh.commands[0]?.command.command).toContain("git init -b main");
    expect(ssh.commands[1]?.command.command).toContain("HELLO.md");
    expect(ssh.commands[2]?.command.command).toBe("git diff --no-color HEAD~1..HEAD");
    expect(ssh.commands[3]?.command.command).toBe("git log -1 --format='%H%x09%s' HEAD");
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
