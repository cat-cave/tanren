import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { defineFailure } from "../src/engine/failure.js";
import { createFakeWriter } from "./fixtures/fakeWriter.js";
import { parseGitLogCommit, prepareGitWorkspace } from "./fixtures/workspaceGit.js";
import {
  bootstrapWorkspace,
  DEFAULT_BOOTSTRAP_COMMAND,
  DEPS_ENSURE_DEFAULT_COMMAND,
  ensureWorkspaceDepsInstalled,
  runWorkspaceSshCommand,
  WorkspaceBootstrapError,
  WorkspaceCommandError,
  WorkspaceDepsInstallError,
  workspaceRepoPathForRun,
} from "../src/engine/workspace/index.js";

const target: RunnerHandle = {
  backend: "ssh",
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
    ).rejects.toThrow("slow step failed: timed out");

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

  it("surfaces the FAILED COMMAND + stderr tail on a workspace command failure (no opaque `failed: exit 1`)", async () => {
    // The exact apex-v23 shape: a bootstrap commit that exits 1 with the git
    // auto-detect-email error on stderr. The loud message must name the command
    // that failed AND carry its stderr — not just `… failed: exit 1`.
    const stderr = "fatal: unable to auto-detect email address (got 'tanren@host.(none)')";
    const ssh = new ScriptedSsh([{ exitCode: 1, stdout: "", stderr, timedOut: false }]);
    let error: unknown;
    try {
      await runWorkspaceSshCommand(ssh, target, {
        label: "commit bootstrap state",
        command: "git add -A && git commit -m bootstrap",
        timeoutMs: 50,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WorkspaceCommandError);
    const message = (error as WorkspaceCommandError).message;
    expect(message).toContain("commit bootstrap state failed: exit 1");
    // The failed command is surfaced.
    expect(message).toContain("command: git add -A && git commit -m bootstrap");
    // The stderr tail is surfaced (the actual root-cause line).
    expect(message).toContain(`stderr: ${stderr}`);
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

  it("disables pnpm's interactive modules-purge confirmation (no-TTY runner) on both defaults", () => {
    // The runner has no TTY; without this flag pnpm aborts a node_modules purge with
    // ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY (exit 1). Must NOT be solved via
    // CI=true (that would force --frozen-lockfile and break the greenfield deps-ensure).
    expect(DEFAULT_BOOTSTRAP_COMMAND).toContain("pnpm install --frozen-lockfile --config.confirmModulesPurge=false");
    expect(DEPS_ENSURE_DEFAULT_COMMAND).toContain("pnpm install --config.confirmModulesPurge=false");
    expect(DEFAULT_BOOTSTRAP_COMMAND).not.toContain("CI=true");
    expect(DEPS_ENSURE_DEFAULT_COMMAND).not.toContain("CI=true");
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

describe("ensureWorkspaceDepsInstalled (greenfield deps-ensure)", () => {
  const workspacePath = workspaceRepoPathForRun("run_ensure");

  // Interprets the guarded install command against a virtual workspace: is a
  // manifest (package.json / pnpm-workspace.yaml) present? The P0 fix makes the
  // guard run the install WHENEVER a manifest exists — it no longer also requires
  // node_modules to be absent (pnpm/npm is the idempotency authority). So
  // `nodeModules` is tracked only to PROVE the install still runs when it is
  // present (the core regression). The install branch echoes the install sentinel;
  // the no-manifest branch echoes the no-op sentinel — matching the runner guard.
  class FsAwareSsh implements CommandSubstrate {
    readonly commands: RunnerCommand[] = [];
    installRan = false;
    constructor(
      private readonly fs: { manifest: boolean; nodeModules: boolean },
      // When the install runs, the exit code it returns (0 = success, else fail).
      private readonly installExit: number = 0,
    ) {}
    async run(_target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
      this.commands.push(command);
      // The new guard: install whenever a manifest exists (node_modules state is
      // irrelevant — a redundant install is a cheap no-op the real pnpm/npm owns).
      const shouldInstall = this.fs.manifest;
      if (shouldInstall) {
        this.installRan = true;
        const failed = this.installExit !== 0;
        return {
          exitCode: this.installExit,
          stdout: `tanren: deps-ensure installing\n${failed ? "" : "Packages: +120"}`,
          stderr: failed ? "vitest: not found" : "",
          timedOut: false,
        };
      }
      return { exitCode: 0, stdout: "tanren: deps-ensure no-op", stderr: "", timedOut: false };
    }
  }

  it("runs the install when a manifest is present", async () => {
    const ssh = new FsAwareSsh({ manifest: true, nodeModules: false });
    const result = await ensureWorkspaceDepsInstalled({
      ssh,
      target,
      workspacePath,
      command: "pnpm install --frozen-lockfile",
      timeoutMs: 100,
    });
    expect(result.installed).toBe(true);
    expect(ssh.installRan).toBe(true);
    // The guard runs in the workspace dir and embeds the resolved install command.
    expect(ssh.commands[0]?.command).toContain("pnpm install --frozen-lockfile");
    expect(ssh.commands[0]?.cwd).toBe(workspacePath);
  });

  // P0 CORE REGRESSION: the old guard (`[ ! -d node_modules ]`) meant that once
  // ANY partial install created node_modules, a LATER writer-added devDep was
  // never installed → the gate died on `vitest: not found`. The fix re-installs
  // whenever a manifest exists, EVEN when node_modules is already present, so the
  // writer's freshly-added devDep is actually installed before the gate.
  it("re-installs when a manifest exists even though node_modules is already present", async () => {
    const ssh = new FsAwareSsh({ manifest: true, nodeModules: true });
    const result = await ensureWorkspaceDepsInstalled({ ssh, target, workspacePath, timeoutMs: 100 });
    expect(result.installed).toBe(true);
    expect(ssh.installRan).toBe(true);
    // The guard does NOT condition on node_modules anymore — it only probes for a
    // manifest before running the install.
    expect(ssh.commands[0]?.command).not.toContain("node_modules");
    expect(ssh.commands[0]?.command).toContain("package.json");
  });

  it("no-ops when no manifest exists yet (greenfield clone HEAD, pre-writer)", async () => {
    const ssh = new FsAwareSsh({ manifest: false, nodeModules: false });
    const result = await ensureWorkspaceDepsInstalled({ ssh, target, workspacePath, timeoutMs: 100 });
    expect(result.installed).toBe(false);
    expect(ssh.installRan).toBe(false);
  });

  it("defaults to the NON-FROZEN pnpm/npm-detecting deps-ensure command", async () => {
    const ssh = new FsAwareSsh({ manifest: true, nodeModules: false });
    await ensureWorkspaceDepsInstalled({ ssh, target, workspacePath, timeoutMs: 100 });
    expect(ssh.commands[0]?.command).toContain(DEPS_ENSURE_DEFAULT_COMMAND);
    // The deps-ensure default must NOT carry --frozen-lockfile (a writer-added
    // devDep without a regenerated lockfile must still install, not hard-fail).
    expect(ssh.commands[0]?.command).not.toContain("--frozen-lockfile");
  });

  it("keeps the app-env prelude OFF the command field — no secret in the typed error", async () => {
    // A failing install with an app env present: the prelude is applied to the
    // EXECUTED guard, but the thrown error must surface the ORIGINAL install
    // command only (no secret value).
    const ssh = new FsAwareSsh({ manifest: true, nodeModules: false }, 1);
    const error = await ensureWorkspaceDepsInstalled({
      ssh,
      target,
      workspacePath,
      command: "pnpm install --frozen-lockfile",
      appEnv: { API_TOKEN: "super-secret-value" },
      timeoutMs: 100,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkspaceDepsInstallError);
    const typed = error as WorkspaceDepsInstallError;
    expect(typed.exitCode).toBe(1);
    expect(typed.command).toBe("pnpm install --frozen-lockfile");
    // The secret VALUE must not appear in the error message / command.
    expect(typed.message).not.toContain("super-secret-value");
    expect(typed.command).not.toContain("super-secret-value");
    expect(typed.outputTail).toContain("vitest: not found");
    // The EXECUTED guard carried the prelude (the substrate boundary), so the env
    // is materialized for the install but never leaks into the error.
    expect(ssh.commands[0]?.command).toContain("super-secret-value");
  });

  it("throws a typed error on a timeout / substrate failure", async () => {
    const timedOut = new ScriptedSsh([{ exitCode: null, stdout: "", stderr: "", timedOut: true }]);
    const timeoutError = await ensureWorkspaceDepsInstalled({
      ssh: timedOut,
      target,
      workspacePath,
      timeoutMs: 50,
    }).catch((caught: unknown) => caught);
    expect(timeoutError).toBeInstanceOf(WorkspaceDepsInstallError);
    expect((timeoutError as WorkspaceDepsInstallError).message).toContain("timed out");
  });
});

class ScriptedSsh implements CommandSubstrate {
  readonly commands: Array<{ target: RunnerHandle; command: RunnerCommand }> = [];

  constructor(private readonly results: CommandResult[]) {}

  async run(sshTarget: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push({ target: sshTarget, command });
    const result = this.results.shift();
    if (result === undefined) {
      throw new Error(`unexpected SSH command: ${command.command}`);
    }
    return result;
  }
}
